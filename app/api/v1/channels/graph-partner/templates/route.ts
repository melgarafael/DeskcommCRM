import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/graph-partner/templates — o espelho desta conexão, com os slots.
 * POST /api/v1/channels/graph-partner/templates — sincroniza, ou CRIA e sincroniza.
 *
 * As definições aprovadas do canal parceiro que espelha a Cloud API (recorte do
 * #1130, de @vgamkt). Espelha a rota do outro parceiro, com três diferenças que
 * importam:
 *
 *  1. resolve a conexão pelo seam deste canal (`findGraphPartnerSession`);
 *  2. grava `contract_hash` REAL (`hashContract`), e não string vazia — sem ele
 *     a trava de obsolescência não acusa que o modelo mudou na plataforma;
 *  3. o GET devolve os SLOTS derivados do contrato, como a rota do canal
 *     oficial: sem eles o seletor da janela fechada não pede os `{{n}}`, e o
 *     pré-voo do envio recusa todo modelo que tenha variável.
 *
 * ─── Desligado por padrão ───────────────────────────────────────────────────
 *
 * Canal opcional da INSTALAÇÃO (decisão do dono, doc 54, opção b): com o
 * interruptor desligado, 404 antes de qualquer outra coisa — nem o papel é
 * perguntado, como na rota de conexão.
 *
 * ─── Quem pode ──────────────────────────────────────────────────────────────
 *
 * Ler (`agent`): é a lista que o seletor do inbox usa, e quem atende precisa
 * dela. Sincronizar e criar (`admin`): escreve na conta da empresa na
 * plataforma, como a gestão de modelos do canal oficial.
 *
 * A rota não nomeia o provider: pede o adapter da sessão e chama
 * `adapter.templates`. Todo o nome vive em `lib/channels/` (`lint:channels`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { canalGraphParceiroLigado } from "@/lib/channels/graph-parceiro/credentials";
import { findGraphPartnerSession } from "@/lib/channels/graph-parceiro/session";
import { slotKey } from "@/lib/channels/meta/build-components";
import { hashContract } from "@/lib/channels/meta/contract-hash";
import { deriveTemplateContract, describeAddress } from "@/lib/channels/meta/template-contract";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * O corpo do POST. `components` viaja cru até a plataforma — ela é quem valida
 * o formato e devolve o motivo; aqui só se garante a forma (lista de objetos,
 * com teto) e o vocabulário fechado da categoria.
 */
const corpoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("sincronizar") }),
  z.object({
    acao: z.literal("criar"),
    name: z.string().trim().min(1).max(512),
    language: z.string().trim().min(2).max(15),
    category: z.enum(["AUTHENTICATION", "MARKETING", "UTILITY"]).default("UTILITY"),
    components: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
  }),
]);

interface Contexto {
  orgId: string;
  userId: string;
  sessionId: string;
  sessionRef: string;
  provider: ChannelProvider;
  idioma: Idioma;
}

/**
 * Interruptor + papel + conexão, ou a resposta de erro pronta.
 *
 * A organização vem da sessão autenticada e a conexão do banco — nunca do
 * corpo (anti-pattern nº 10: daria a um tenant a lista do outro).
 */
async function contexto(
  requestId: string,
  papel: "agent" | "admin",
): Promise<{ ok: true; ctx: Contexto } | { ok: false; res: Response }> {
  if (!canalGraphParceiroLigado()) {
    return { ok: false, res: fail("not_found", "not found", 404, { requestId }) };
  }
  const authz = await requireRole(papel, { requestId, resource: "channels_graph_partner_templates" });
  if (!authz.ok) return { ok: false, res: authz.response };
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const sessao = await findGraphPartnerSession(admin, orgId);
  if (!sessao || sessao.archivedAt) {
    return {
      ok: false,
      res: fail("not_found", t("Nenhuma conexão de parceiro ativa."), 404, { requestId }),
    };
  }

  const { data: linha } = await admin
    .from("channel_sessions")
    // As COLUNAS do ref vêm do seam — escrevê-las à mão aqui nomeia providers.
    .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("organization_id", orgId)
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
    ctx: {
      orgId,
      userId: authz.user.id,
      sessionId: sessao.id,
      sessionRef,
      provider,
      idioma: authz.user.idioma,
    },
  };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const r = await contexto(requestId, "agent");
  if (!r.ok) return r.res;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_templates")
    .select("name, language, status, category, rejected_reason, components, parameter_format, synced_at")
    .eq("organization_id", r.ctx.orgId)
    .eq("channel_session_id", r.ctx.sessionId)
    .order("status")
    .order("name");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(
    {
      templates: (data ?? []).map((row) => {
        const contrato = deriveTemplateContract({
          name: row.name as string,
          language: row.language as string,
          parameter_format: (row.parameter_format as string | null) ?? undefined,
          components: row.components as never,
        });
        return {
          name: row.name as string,
          language: row.language as string,
          status: row.status as string,
          category: (row.category as string | null) ?? null,
          rejectedReason: (row.rejected_reason as string | null) ?? null,
          syncedAt: row.synced_at as string,
          components: (row.components as unknown[]) ?? [],
          // A MESMA derivação da rota do canal oficial: é daqui que o seletor
          // da janela fechada monta os campos, com a chave que o envio confere.
          slots: contrato.slots.map((s) => ({
            key: s.key,
            expects: s.expects,
            onde: describeAddress(s.address),
            valueKey: slotKey(s.address, s.key),
          })),
        };
      }),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const r = await contexto(requestId, "admin");
  if (!r.ok) return r.res;
  const t = (texto: string) => traduzir(texto, r.ctx.idioma);

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Faltam nome, idioma ou conteúdo."), 422, { requestId });
  }
  const corpo = parsed.data;

  const adapter = getAdapter(r.ctx.provider);
  if (!adapter.templates) {
    return fail("not_implemented", t("Este canal não gerencia definições."), 501, { requestId });
  }

  try {
    if (corpo.acao === "criar") {
      await adapter.templates.create({
        organizationId: r.ctx.orgId,
        sessionRef: r.ctx.sessionRef,
        draft: {
          name: corpo.name,
          language: corpo.language,
          category: corpo.category,
          components: corpo.components,
        },
      });
      await audit({
        action: "template.created",
        actorUserId: r.ctx.userId,
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
      const parameterFormat = tpl.parameterFormat === "NAMED" ? "NAMED" : "POSITIONAL";
      const { error } = await admin.from("meta_templates").upsert(
        {
          organization_id: r.ctx.orgId,
          channel_session_id: r.ctx.sessionId,
          // O nome da coluna é da época em que só havia um canal: aqui ela
          // guarda o identificador da CONEXÃO no provider (sessionRef), como no
          // outro parceiro. Com a conta de verdade, uma WABA ligada também pelo
          // canal oficial colidiria na chave única e trocaria o dono da linha.
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
        logger.warn("[graph-partner/templates] upsert falhou", { name: tpl.name, detail: error.message });
        continue;
      }
      gravadas++;
    }

    return ok({ sincronizadas: gravadas, total: remotas.length }, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro";
    logger.error("[graph-partner/templates] falhou", { detail: msg, requestId });
    // A mensagem da plataforma CHEGA ao operador: é ela que distingue "nome
    // inválido" de "conta sem permissão". Nunca carrega o token (vai no header).
    return fail("upstream_error", msg, 502, { requestId });
  }
}
