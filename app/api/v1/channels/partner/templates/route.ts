/**
 * As definições aprovadas do canal INTERMEDIADO — listar, sincronizar, criar.
 *
 * ─── Por que uma rota nova, e não a de sempre ──────────────────────────────
 *
 * `/api/v1/channels/templates` resolve a conexão por `metaSessionForOrg` e lê
 * `wabaId`. Numa instalação que só tem o canal intermediado, isso devolve lista
 * VAZIA — e o operador conclui que não tem nenhuma definição aprovada quando
 * tem várias. Foi exatamente o que aconteceu: o seletor do inbox dizia "nenhum
 * modelo aprovado ainda" para uma conta cheia deles.
 *
 * A rota de lá continua intacta. Fundir as duas exigiria mexer no caminho do
 * canal oficial, que funciona, para servir um canal que ele não conhece.
 *
 * ─── Tudo passa pelo seam ──────────────────────────────────────────────────
 *
 * Esta rota não sabe com QUEM fala: pede o adapter da sessão e chama
 * `adapter.templates`. Quem não implementa devolve 501, e nenhum nome de
 * provider aparece aqui — o `lint:channels` reprovaria.
 *
 * ─── O espelho carrega a conexão de origem (migration 0144) ───────────────
 *
 * `channel_session_id` é o que permite responder "o que posso usar NESTA
 * conexão?". Sem ele, dois números do mesmo provider dividiriam a mesma lista.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { findPartnerSession } from "@/lib/channels/connect";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface Contexto {
  orgId: string;
  sessionId: string;
  sessionRef: string;
  provider: ChannelProvider;
}

/**
 * Resolve org + conexão + adapter, ou devolve a resposta de erro pronta.
 *
 * A conexão vem do banco e não do corpo: `organization_id` tirado do body é o
 * anti-pattern nº 10 da doutrina, e aqui daria a um tenant a lista do outro.
 */
async function contexto(
  requestId: string,
): Promise<{ ok: true; ctx: Contexto } | { ok: false; res: Response }> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, res: fail("unauthenticated", "Faça login.", 401, { requestId }) };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, res: fail("forbidden", "Sem organização ativa.", 403, { requestId }) };

  const admin = createAdminClient();
  const sessao = await findPartnerSession(admin, org.orgId);
  if (!sessao || sessao.archivedAt) {
    return {
      ok: false,
      res: fail("not_found", "Nenhuma conexão de parceiro ativa.", 404, { requestId }),
    };
  }

  const { data: linha } = await admin
    .from("channel_sessions")
    // As COLUNAS do ref vêm do seam. Escrevê-las à mão aqui nomeia os providers
    // — e o `lint:channels` reprovou a primeira versão deste arquivo por isso,
    // que é a catraca funcionando.
    .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("id", sessao.id)
    .maybeSingle();

  const provider = ((linha?.provider as string) ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider;
  const sessionRef = linha ? resolveSessionRef(linha as unknown as ChannelSessionRef) : null;
  if (!sessionRef) {
    return {
      ok: false,
      res: fail("failed_precondition", "Conexão sem identificador utilizável.", 409, { requestId }),
    };
  }

  return { ok: true, ctx: { orgId: org.orgId, sessionId: sessao.id, sessionRef, provider } };
}

/** Lista o que está ESPELHADO. Rápido, e é o que a tela mostra. */
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
        // O CONTEÚDO, e não só o estado. Ver "APPROVED" sem ver o texto obriga
        // o operador a abrir a plataforma para saber o que a definição diz —
        // e é o texto que ele precisa para escolher qual mandar.
        components: (t.components as unknown[]) ?? [],
      })),
    },
    { requestId },
  );
}

/**
 * Sincroniza com a plataforma, ou CRIA uma definição nova.
 *
 * Duas ações na mesma rota porque as duas terminam no mesmo lugar — o espelho —
 * e separá-las obrigaria a tela a saber que criar também sincroniza.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Cria/sincroniza definição aprovada pela Meta e pode derrubar a sessão de
  // WhatsApp indiretamente (uploads e mensagens dependem da mesma conexão) —
  // mesmo piso de "channels/templates" e "channels/official" (admin).
  const authz = await requireRole("admin", { requestId, resource: "channel_partner_templates" });
  if (!authz.ok) return authz.response;

  const r = await contexto(requestId);
  if (!r.ok) return r.res;

  const adapter = getAdapter(r.ctx.provider);
  if (!adapter.templates) {
    return fail("not_implemented", "Este canal não gerencia definições.", 501, { requestId });
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
        return fail("invalid_request", "Faltam nome, idioma ou conteúdo.", 400, { requestId });
      }
      // A plataforma valida o formato do nome e devolve o motivo com código. Não
      // duplicamos a regra: regra copiada envelhece separado da fonte.
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
    // revisão, e o operador precisa VER que ela existe e está pendente. Sem
    // isso ele criaria a mesma de novo, achando que não salvou.
    const remotas = await adapter.templates.list({
      organizationId: r.ctx.orgId,
      sessionRef: r.ctx.sessionRef,
    });
    const admin = createAdminClient();
    const agora = new Date().toISOString();

    let gravadas = 0;
    for (const t of remotas) {
      const { error } = await admin.from("meta_templates").upsert(
        {
          organization_id: r.ctx.orgId,
          channel_session_id: r.ctx.sessionId,
          // A chave de unicidade herdada é `(org, waba_id, name, language)`. A
          // conta do provider ocupa o lugar do waba porque é o que ela é: o id
          // da conta na plataforma. O nome da coluna é da época em que só havia
          // um canal; trocá-lo mexeria no caminho do outro, que funciona.
          waba_id: r.ctx.sessionRef,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          rejected_reason: t.rejectedReason ?? null,
          components: t.components,
          contract_hash: "",
          parameter_format: t.parameterFormat ?? "POSITIONAL",
          synced_at: agora,
          updated_at: agora,
        },
        { onConflict: "organization_id,waba_id,name,language" },
      );
      if (error) {
        logger.warn("[partner/templates] upsert falhou", { name: t.name, detail: error.message });
        continue;
      }
      gravadas++;
    }

    return ok({ sincronizadas: gravadas, total: remotas.length }, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    logger.error("[partner/templates] falhou", { detail: msg, requestId });
    // A mensagem do provider CHEGA ao operador: é ela que distingue "nome
    // inválido" de "conta sem permissão", e sem ela a tela diz só "falhou".
    return fail("upstream_error", msg, 502, { requestId });
  }
}
