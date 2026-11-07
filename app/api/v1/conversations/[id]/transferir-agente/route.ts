import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/transferir-agente — passa a conversa de um
 * agente de IA para outro, no MESMO número (#3770).
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * A passagem entre agentes de IA só existia como efeito do classificador: com
 * roteador sticky, a próxima mensagem do cliente é classificada e, se casar com
 * o membro certo, o agente muda (`ai_router_decisions.outcome = 'reclassified'`).
 * Não havia como PEDIR a passagem — dependia de o modelo acertar a descrição do
 * membro, a cada mensagem, e custava uma chamada de classificador por mensagem.
 *
 * Esta rota é a ação explícita: o destino vem no corpo, nada é classificado, e a
 * decisão entra na trilha do roteador com desfecho e origem próprios
 * (`transferred` / `acao`) — ver `lib/agent-engine/agent/transferir-agente.ts`,
 * que é quem faz o trabalho e é reusável por qualquer caminho do motor que já
 * tenha (organização, conversa).
 *
 * ─── O que esta rota NÃO faz (declarado, não esquecido) ────────────────────
 *
 * Passagem entre NÚMEROS diferentes continua impossível: a origem de serviço
 * (`serviceForAutomation`, `fn_service_event_origin`) recusa `channel_session_id`
 * diferente do da conversa, e esta ação não toca nessa trava. O destino que não
 * atende neste número é RECUSADO com 409 (`agente_de_outro_numero`), nunca
 * gravado como sticky que o turno seguinte ignoraria.
 *
 * ─── Auth ──────────────────────────────────────────────────────────────────
 *
 * Cookie session, agent+ (spec 13 §4: escrita é agent+, viewer é read-only):
 * passar a conversa para outro agente é a mesma classe de gesto de transferir
 * para um colega, que já é agent+. A leitura da conversa é feita pelo cliente da
 * SESSÃO — é a policy `conversations_select` que aplica o `visibility_mode`, e
 * ler com service role deixaria um agent transferir uma conversa que ele nem
 * enxerga.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE,
  TransferenciaDeAgenteRecusada,
  transferirAgenteDaConversa,
} from "@/lib/agent-engine/agent/transferir-agente";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corpoSchema = z
  .object({
    agente_id: z.string().uuid(),
    // O motivo é vocabulário FECHADO (`transferir-agente.ts`), nunca texto
    // livre: a linha de trilha é lida por toda a organização e a tabela tem
    // contrato de "sem PII" desde a 0085.
    motivo: z.enum(MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE).default("pedido_do_operador"),
  })
  .strict();

/** Recusa da ação → status HTTP. Recusa não é falha: cada uma tem o seu. */
const STATUS_DA_RECUSA: Record<string, number> = {
  conversa_nao_encontrada: 404,
  agente_inexistente: 422,
  agente_de_outro_numero: 409,
  agente_fora_do_roteador: 409,
  ja_esta_no_agente: 409,
};

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  let corpo: z.infer<typeof corpoSchema>;
  try {
    corpo = corpoSchema.parse(await req.json());
  } catch {
    return fail(
      "invalid_request",
      t("Informe o agente de destino (agente_id) e um motivo válido."),
      422,
      { requestId },
    );
  }

  const supabase = await createClient();

  // Client do REQUEST, nunca admin: quem não enxerga a conversa não a transfere.
  const { data: conversa, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  let resultado;
  try {
    resultado = await transferirAgenteDaConversa(getRequestPool(), {
      organizationId: org.orgId,
      conversationId: id,
      agenteDestinoId: corpo.agente_id,
      motivo: corpo.motivo,
      solicitadoPor: user.id,
    });
  } catch (err) {
    if (err instanceof TransferenciaDeAgenteRecusada) {
      const status = STATUS_DA_RECUSA[err.codigo] ?? 422;
      return fail(err.codigo, t(err.message), status, { requestId });
    }
    // `getRequestPool` sem SUPABASE_DB_URL é instalação sem caminho para o
    // banco do motor: a ação não está disponível aqui, e isso é 503 — nunca
    // 500 com stack na resposta.
    if (process.env.SUPABASE_DB_URL === undefined || process.env.SUPABASE_DB_URL === "") {
      return fail(
        "unavailable",
        t("Passagem entre agentes de IA indisponível nesta instalação."),
        503,
        { requestId },
      );
    }
    throw err;
  }

  await audit({
    action: "conversation.ai_agent_transferred",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: {
      agente_anterior_id: resultado.agenteAnteriorId,
      agente_id: resultado.agenteDestinoId,
      motivo: corpo.motivo,
      ...(resultado.routerId ? { router_id: resultado.routerId } : {}),
    },
  });

  return ok(
    {
      agente_anterior_id: resultado.agenteAnteriorId,
      agente_id: resultado.agenteDestinoId,
      intent_name: resultado.intentName,
      router_id: resultado.routerId,
    },
    { requestId },
  );
}
