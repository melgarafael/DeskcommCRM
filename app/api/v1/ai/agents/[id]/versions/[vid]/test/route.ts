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

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { testRunSchema } from "@/lib/ai/agents/validation";
import { avaliarRespostaDeTeste } from "@/lib/ai/agents/avaliar-resposta-de-teste";
import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string; vid: string }> };

/**
 * Fecha a linha do run — e RECLAMA se não conseguir.
 *
 * O INSERT desta rota sempre checou o erro; os dois UPDATEs não checavam
 * nenhum, e foi por isso que um status fora do CHECK pôde ficar dois releases
 * no código sem ninguém ver. Falhar aqui não derruba o teste (o resultado já
 * está pronto e vai para a tela de qualquer jeito), mas tem que deixar rastro:
 * um update de fechamento que não fecha é exatamente o defeito que se quer
 * enxergar.
 */
async function atualizarRun(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  runId: string,
  requestId: string,
  campos: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("ai_agent_runs")
    .update(campos)
    .eq("organization_id", organizationId)
    .eq("id", runId);
  if (error) {
    logger.error("[ai.test] não foi possível fechar a linha do teste", {
      request_id: requestId,
      run_id: runId,
      organization_id: organizationId,
      status_pretendido: campos.status,
      error: error.message,
    });
  }
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, vid } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(vid)) {
    return fail("invalid_request", "ids inválidos.", 400, { requestId });
  }

  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = testRunSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  const { data: version } = await admin
    .from("ai_agent_versions")
    .select(
      "id, agent_id, organization_id, system_prompt, provider, model, channel_session_id, max_steps, token_budget, cost_budget_cents, tool_ids",
    )
    .eq("id", vid)
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", id)
    .maybeSingle();

  if (!version) return fail("not_found", t("Version não encontrada."), 404, { requestId });

  const startedAt = new Date();

  const { data: runRow, error: runErr } = await admin
    .from("ai_agent_runs")
    .insert({
      organization_id: activeOrg.orgId,
      agent_id: id,
      agent_version_id: vid,
      conversation_id: null,
      contact_id: null,
      channel_session_id: version.channel_session_id,
      inbound_message_id: null,
      outbound_message_id: null,
      status: "running",
      is_dry_run: true,
      started_at: startedAt.toISOString(),
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return fail("internal_error", "Erro ao iniciar test run.", 500, { requestId });
  }

  let resultPayload: Record<string, unknown>;

  try {
    const result = await testAgentVersion(getRequestPool(), requestTurnDeps(), {
      organizationId: activeOrg.orgId,
      agentId: id,
      versionId: vid,
      runId: runRow.id,
      sampleMessage: parsed.data.sample_message,
      sampleContact: parsed.data.sample_contact,
      channelId: version.channel_session_id,
    });
    const finalText = result.candidates.map((c) => c.body).join("\n\n");
    resultPayload = {
      run_id: runRow.id,
      status: result.candidates.length ? "ok" : "blocked",
      latency_ms: Date.now() - startedAt.getTime(),
      final_text: finalText,
      tool_calls: result.proposals,
      ...result,
      stub: process.env.INTERNAL_AGENT_RUN_STUB === "true",
      guardrails: avaliarRespostaDeTeste(finalText),
    };
    // ⚠️ `completed`, não `"ok"`. O CHECK da coluna aceita
    // pending|running|completed|failed|aborted|handoff — `"ok"` é o vocabulário
    // de `llm_calls`, que é outra tabela. Enquanto esteve `"ok"` aqui, TODO
    // update era rejeitado pelo Postgres com 23514 e o erro era descartado (o
    // `await` não olhava `error`, ao contrário do INSERT logo acima): a linha
    // nascia `running` e morria `running`, em toda instalação, para sempre.
    // Medido numa VPS v1.20.0: 16 execuções, 16 linhas em `running`.
    await atualizarRun(admin, activeOrg.orgId, runRow.id, requestId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt.getTime(),
      // `steps_count`, `tokens_in`, `tokens_out` e `cost_cents` seguem em zero
      // de propósito: o turno de prévia não devolve essas contagens à rota, e
      // gravar `candidates.length` no lugar de passos seria um número errado com
      // cara de certo. Quem tem o dado é `llm_calls` (`purpose='agent_preview'`),
      // e ligar as duas é trabalho à parte — não se conserta um zero honesto com
      // um palpite.
      tool_calls: JSON.parse(JSON.stringify(result.proposals)),
    });
  } catch (err) {
    // ⚠️ Este `catch` era vazio, e engolir o erro aqui é o que tornava o
    // problema INDIAGNOSTICÁVEL: o teste falhava, a tela dizia uma frase
    // genérica sobre modelo e credencial, e a causa real não existia em lugar
    // nenhum — nem no log, nem na linha do run, nem na resposta.
    const mensagem = err instanceof Error ? err.message : String(err);
    logger.error("[ai.test] o teste do agente falhou", {
      request_id: requestId,
      run_id: runRow.id,
      agent_id: id,
      version_id: vid,
      organization_id: activeOrg.orgId,
      error: mensagem,
    });
    await atualizarRun(admin, activeOrg.orgId, runRow.id, requestId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt.getTime(),
      error_code: "preview_failed",
      // Guardado na linha para quem for diagnosticar depois; a resposta ao
      // operador segue genérica, porque o texto do erro é técnico.
      error_message: mensagem.slice(0, 2000),
    });
    return fail(
      "preview_failed",
      t("Não foi possível executar o teste. Confira modelo, credencial e materiais do agente."),
      422,
      { requestId },
    );
  }

  void audit({
    action: "ai_agent.tested",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent_version",
    resourceId: vid,
    requestId,
    metadata: { run_id: runRow.id, dry_run: true },
  });

  return ok(resultPayload, { requestId });
}
