import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * As definições aprovadas do parceiro Graph-compatível — listar, sincronizar,
 * criar.
 *
 * Espelha a rota do outro parceiro, com duas diferenças que importam:
 *
 *  1. resolve a conexão pelo seam do parceiro Graph (`findGraphPartnerSession`),
 *     não pela conexão de credencial antiga;
 *  2. grava `contract_hash` REAL (`hashContract`), e não string vazia — sem ele
 *     a trava de obsolescência do `conferirDefinicao`/`sendTemplate` não acusa
 *     que o modelo mudou na plataforma.
 *
 * A rota não nomeia o provider: pede o adapter da sessão e chama
 * `adapter.templates`. Todo o nome vive em `lib/channels/`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { findGraphPartnerSession } from "@/lib/channels/graph-parceiro/session";
import { hashContract } from "@/lib/channels/meta/contract-hash";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface Contexto {
  orgId: string;
  sessionId: string;
  sessionRef: string;
  provider: ChannelProvider;
  idioma: Idioma;
}

async function contexto(
  requestId: string,
): Promise<{ ok: true; ctx: Contexto } | { ok: false; res: Response }> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, res: fail("unauthenticated", "Faça login.", 401, { requestId }) };
  const t = (texto: string) => traduzir(texto, user.idioma);
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, res: fail("forbidden", t("Sem organização ativa."), 403, { requestId }) };

  const admin = createAdminClient();
  const sessao = await findGraphPartnerSession(admin, org.orgId);
  if (!sessao || sessao.archivedAt) {
    return { ok: false, res: fail("not_found", t("Nenhuma conexão ativa."), 404, { requestId }) };
  }

  const { data: linha } = await admin
    .from("channel_sessions")
    // As COLUNAS do ref vêm do seam — escrevê-las à mão aqui nomeia providers.
    .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("id", sessao.id)
    .maybeSingle();

  const provider = ((linha?.provider as string) ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider;
  const sessionRef = linha ? resolveSessionRef(linha as unknown as ChannelSessionRef) : null;
  if (!sessionRef) {
    return {
      ok: false,
      res: fail("failed_precondition", t("Conexão sem identificador utilizável."), 409, { requestId }),
    };
  }

  return {
    ok: true,
    ctx: { orgId: org.orgId, sessionId: sessao.id, sessionRef, provider, idioma: user.idioma },
  };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const r = await contexto(requestId);
  if (!r.ok) return r.res;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_templates")
    .select("name, language, status, category, rejected_reason, components, synced_at")
    .eq("organization_id", r.ctx.orgId)
    .eq("channel_session_id", r.ctx.sessionId)
    .order("status")
    .order("name");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(
    {
      templates: (data ?? []).map((t) => ({
        name: t.name as string,
        language: t.language as string,
        status: t.status as string,
        category: (t.category as string | null) ?? null,
        rejectedReason: (t.rejected_reason as string | null) ?? null,
        syncedAt: t.synced_at as string,
        components: (t.components as unknown[]) ?? [],
      })),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await contexto(requestId);
  if (!r.ok) return r.res;
  const t = (texto: string) => traduzir(texto, r.ctx.idioma);

  const adapter = getAdapter(r.ctx.provider);
  if (!adapter.templates) {
    return fail("not_implemented", t("Este canal não gerencia definições."), 501, { requestId });
  }

  const corpo = (await req.json().catch(() => ({}))) as {
    acao?: string;
    name?: string;
    language?: string;
    category?: string;
    components?: unknown[];
  };

  try {
    if (corpo.acao === "criar") {
      if (!corpo.name || !corpo.language || !Array.isArray(corpo.components)) {
        return fail("invalid_request", t("Faltam nome, idioma ou conteúdo."), 400, { requestId });
      }
      await adapter.templates.create({
        organizationId: r.ctx.orgId,
        sessionRef: r.ctx.sessionRef,
        draft: {
          name: corpo.name,
          language: corpo.language,
          category: (corpo.category ?? "UTILITY") as "AUTHENTICATION" | "MARKETING" | "UTILITY",
          components: corpo.components,
        },
      });
      await audit({
        action: "template.created",
        organizationId: r.ctx.orgId,
        resourceType: "channel_session",
        resourceId: r.ctx.sessionId,
        requestId,
        metadata: { name: corpo.name, language: corpo.language },
      });
    }

    // Sincroniza sempre — inclusive depois de criar: a definição nasce em
    // revisão e o operador precisa VER que ela existe e está pendente.
    const remotas = await adapter.templates.list({
      organizationId: r.ctx.orgId,
      sessionRef: r.ctx.sessionRef,
    });
    const admin = createAdminClient();
    const agora = new Date().toISOString();

    let gravadas = 0;
    for (const tpl of remotas) {
      const parameterFormat = tpl.parameterFormat ?? "POSITIONAL";
      const { error } = await admin.from("meta_templates").upsert(
        {
          organization_id: r.ctx.orgId,
          channel_session_id: r.ctx.sessionId,
          // O nome da coluna é da época em que só havia um canal: aqui ela
          // guarda o identificador da CONTA do provider (sessionRef), como no
          // outro parceiro — a escopo real é `channel_session_id`.
          waba_id: r.ctx.sessionRef,
          name: tpl.name,
          language: tpl.language,
          status: tpl.status,
          category: tpl.category,
          rejected_reason: tpl.rejectedReason ?? null,
          components: tpl.components,
          // Hash REAL: é o que faz o pré-voo acusar "mudou na plataforma".
          contract_hash: hashContract(tpl.components, parameterFormat),
          parameter_format: parameterFormat,
          synced_at: agora,
          updated_at: agora,
        },
        { onConflict: "organization_id,waba_id,name,language" },
      );
      if (error) {
        logger.warn("[graph/templates] upsert falhou", { name: tpl.name, detail: error.message });
        continue;
      }
      gravadas++;
    }

    return ok({ sincronizadas: gravadas, total: remotas.length }, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    logger.error("[graph/templates] falhou", { detail: msg, requestId });
    return fail("upstream_error", msg, 502, { requestId });
  }
}
