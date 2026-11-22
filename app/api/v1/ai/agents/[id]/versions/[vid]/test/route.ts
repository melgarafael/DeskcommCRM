import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/agents/:id/versions/:vid/test (admin)
 *
 * Spec 10 §4.4. Cria ai_agent_runs com is_dry_run=true e executa o runtime
 * real. ⚠️ Não é mais `callInternalRuntime` → `runAgent`, como esta linha
 * afirmou por vários releases: aquele runtime (`lib/ai/runtime`) está aposentado
 * desde a Fase 0 — o cron `agent-dispatcher` responde `deprecated: true`. Quem
 * roda hoje é `testAgentVersion` (`lib/agent-engine/agent/sandbox.ts`), o mesmo
 * motor do turno de WhatsApp, em modo prévia. Para conferir sem acreditar nesta
 * linha, leia a chamada mais abaixo.
 *
 * ⚠️ Esta rota é o ÚNICO escritor vivo de `ai_agent_runs`. O caminho normal
 * (WhatsApp) não abre linha nenhuma ali — ele registra em `llm_calls`. Quem
 * procurar o turno real nesta tabela não acha, e não é defeito desta rota.
 *
 * INTERNAL_AGENT_RUN_STUB=true troca a execução por um trace fabricado —
 * serve para exercitar o render da UI sem gastar token, e NÃO é o default:
 * numa instalação nova, "Testar agente" tem que testar o agente.
 *
 * Crítico: dry_run=true → bypass do partial unique
 *   ai_agent_runs_one_running_per_conv (que filtra is_dry_run=false), por
 *   isso múltiplos tests simultâneos pra mesma conversation não conflitam.
 *
 * Sample contact é apenas pra contexto do prompt — nunca toca contacts/conversations
 * tables, nunca chama WAHA, nunca cria messages.outbound.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  testRunSchema,
  LIMITE_DO_HISTORICO_EM_MENSAGENS,
  LIMITE_DO_HISTORICO_EM_CARACTERES,
} from "@/lib/ai/agents/validation";
import { traduzir } from "@/lib/i18n/dicionario";
import { testarVersaoDoAgente } from "@/lib/ai/agents/teste-da-versao";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


type Ctx = { params: Promise<{ id: string; vid: string }> };


export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, vid } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(vid)) {
    return fail("invalid_request", "ids inválidos.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_agents",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId, actor } = authz;

  const teto = await tetoDeEscritaDoToken(authz, "ai_agents_test", requestId);
  if (teto) return teto;
  const authUserId = actor.type === "user" ? actor.id : null;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  /**
   * #4424 — o histórico do teste é recusado ANTES de qualquer trabalho, com uma
   * frase legível e 400 (o corpo está semanticamente errado, não malformado em
   * um campo). Os limites são os mesmos que o schema e o painel usam: sem eles,
   * cada turno reenviaria a conversa inteira e o custo do teste cresceria sem
   * teto. `sample_message` não entra na conta — history é só o PASSADO.
   */
  const historicoPedido = (raw as { history?: unknown } | null)?.history;
  if (Array.isArray(historicoPedido)) {
    const caracteres = historicoPedido.reduce<number>((total, m) => {
      const corpo =
        m && typeof m === "object" && "body" in m && typeof m.body === "string"
          ? m.body.trim().length
          : 0;
      return total + corpo;
    }, 0);
    if (
      historicoPedido.length > LIMITE_DO_HISTORICO_EM_MENSAGENS ||
      caracteres > LIMITE_DO_HISTORICO_EM_CARACTERES
    ) {
      return fail(
        "invalid_request",
        t(
          "O histórico da conversa passou do limite: até 30 mensagens e 20.000 caracteres. Recomece a conversa para seguir.",
        ),
        400,
        { requestId },
      );
    }
  }
  const parsed = testRunSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  // A execução inteira (linha de `ai_agent_runs`, prévia, fechamento, tradução
  // da falha, auditoria) mora em `lib/ai/agents/teste-da-versao.ts` — a mesma
  // que o MCP do CRM usa para testar um rascunho pelo ChatGPT.
  const r = await testarVersaoDoAgente(admin, {
    orgId: organizationId,
    agentId: id,
    versionId: vid,
    pedido: parsed.data,
    ator: { userId: authUserId, apiTokenId: authz.apiTokenId ?? null, requestId },
  });
  if (!r.ok) {
    return fail(r.codigo, r.traduzivel ? t(r.mensagem) : r.mensagem, r.status, { requestId });
  }

  return ok(r.data, { requestId });
}
