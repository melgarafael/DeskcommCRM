import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/routers/:id/test — classifica uma mensagem de TESTE contra o
 * router (manager+). Reusa loadActiveRouter/classifyIntent (Tasks 2-3, mesmo
 * seam de runtime) — NUNCA grava em ai_router_decisions (telemetria de
 * decisões reais de produção, não de teste) nem em conversations.
 *
 * leadId/jobId vão null pro classificador: não existe contact/job real por
 * trás de um clique de teste na UI, e llm_calls.contact_id/job_id são FKs —
 * um uuid inventado quebraria o insert do registro de custo (ver
 * lib/agent-engine/agent/intent-classifier.ts).
 *
 * O match só conta se confidence >= min_confidence do router (a MESMA régua do
 * runtime, `destinoDoVeredito` em resolve-turn-agent.ts, sem sticky: o teste não
 * tem conversa) — devolve min_confidence no payload pra a tela explicar quando
 * o resultado cairia no fallback/genérico em produção.
 *
 * Com a tarefa do roteador do Jev rodando, o Jev responde a mesma frase ao mesmo
 * tempo, e a tela mostra as duas escolhas lado a lado (`jev`). Nada disso vira
 * observação (R5): uma frase digitada por quem configura não é concordância de
 * atendimento. O custo dele entra em `llm_calls`, como o do classificador de
 * sempre neste mesmo clique (R8). Decidindo, a escolha dele é a que valeria em
 * produção — com a IA de sempre respondendo; sem ela, vale a regra de hoje (R2).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { env } from "@/lib/env";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { classifyIntent, type IntentVerdict } from "@/lib/agent-engine/agent/intent-classifier";
import { destinoDoVeredito } from "@/lib/agent-engine/agent/resolve-turn-agent";
import { consultarJevNoRoteador, registrarRoteadorDoJev } from "@/lib/ai/decisao/roteador";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const testSchema = z.object({
  message: z.string().min(1).max(4000),
});

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "ai_routers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = testSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data: router, error: routerErr } = await admin
    .from("ai_routers")
    .select("id, channel_session_id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (routerErr) {
    return fail("internal_error", "Erro ao carregar router.", 500, { requestId });
  }
  if (!router) {
    return fail("not_found", t("Router não encontrado."), 404, { requestId });
  }

  const pool = getSkillsPool();
  const loaded = await loadActiveRouter(pool, org.orgId, router.channel_session_id);
  if (!loaded || loaded.id !== id) {
    return fail(
      "state_conflict",
      t("O router precisa estar ativo (is_active=true) para ser testado."),
      409,
      { requestId },
    );
  }

  const llmCfg = llmEdgeConfigFromEnv(env);
  const log = createLogger();

  const jev = consultarJevNoRoteador(pool, {
    organizationId: org.orgId,
    mensagem: parsed.data.message,
    membros: loaded.members,
    contactId: null,
    jobId: null,
  });
  const [verdict, estadoDoJev, escolhaDoJev] = await Promise.all([
    classifyIntent(
      pool,
      llmCfg,
      { tenantId: org.orgId, leadId: null, jobId: null, router: loaded, signal: parsed.data.message },
      { log },
    ),
    jev.estado,
    jev.escolha,
  ]);
  if (escolhaDoJev !== null) {
    await registrarRoteadorDoJev(pool, {
      organizationId: org.orgId,
      contactId: null,
      jobId: null,
      jev: escolhaDoJev,
      decidiu: false,
      observacao: null,
    });
  }

  // Sem veredito, ou abaixo do mínimo, produção cai no fallback/genérico — e o
  // painel de teste não pode fingir que casou (review whole-branch item 3).
  const agenteDo = (v: IntentVerdict | null): string | null =>
    destinoDoVeredito(loaded, undefined, null, v).membro?.agentId ?? loaded.fallbackAgentId;
  const nomeDoAgente = async (agentId: string | null): Promise<string | null> => {
    if (!agentId) return null;
    const { data: agentRow } = await admin
      .from("ai_agents")
      .select("name")
      .eq("id", agentId)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    return agentRow?.name ?? null;
  };

  // A saída ilegível segue "nenhuma" para o agente (a régua do turno), mas não
  // é resposta da IA: a tela a mostra como "não respondeu", e o Jev decidindo
  // não vale no lugar dela (R2).
  const iaRespondeu = verdict !== null && verdict.falhou !== true;
  const agentId = agenteDo(verdict);
  const agentName = await nomeDoAgente(agentId);
  const agenteDoJev = escolhaDoJev === null ? null : agenteDo(escolhaDoJev.veredito);

  return ok(
    {
      intent_name: iaRespondeu ? verdict.intentName : null,
      // `?? null`, nunca `?? 0`: sem veredito não houve medição, e zero é uma
      // AFIRMAÇÃO ("o classificador tem certeza de que não é nada"). A tela local
      // escapa por checar `intent_name` antes de exibir, mas isto é contrato de
      // API pública — todo outro consumidor leria a invenção. Doutrina em
      // `lib/kanban/card-state.ts`: null é "sinal insuficiente", 0 é "calculei e deu zero".
      confidence: iaRespondeu ? verdict.confidence : null,
      min_confidence: loaded.minConfidence,
      agent_id: agentId,
      agent_name: agentName,
      // `null` com a tarefa do roteador do Jev desligada (ou o Jev inteiro).
      jev:
        estadoDoJev === "desligada"
          ? null
          : {
              estado: estadoDoJev,
              respondeu: escolhaDoJev !== null,
              intent_name: escolhaDoJev?.veredito.intentName ?? null,
              // A probabilidade calibrada da escolha — sobre ela vale o `min_confidence`.
              confidence: escolhaDoJev?.veredito.confidence ?? null,
              agent_id: agenteDoJev,
              agent_name: agenteDoJev === agentId ? agentName : await nomeDoAgente(agenteDoJev),
              // Em produção vale a escolha dele: decidindo, respondendo, e com a
              // IA de sempre respondendo também (R2).
              decide: estadoDoJev === "decidindo" && escolhaDoJev !== null && iaRespondeu,
            },
    },
    { requestId },
  );
}
