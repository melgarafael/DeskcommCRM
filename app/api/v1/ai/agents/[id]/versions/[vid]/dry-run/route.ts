import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/agents/:id/versions/:vid/dry-run (admin)
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
 *   isso múltiplos ensaios simultâneos pra mesma conversation não conflitam.
 *
 * Sample contact é apenas pra contexto do prompt — nunca toca contacts/conversations
 * tables, nunca chama WAHA, nunca cria messages.outbound.
 *
 * O segmento não se chama `test`: pasta com esse nome o App Router não registra
 * (HTML 404 no lugar deste handler). Ver `lib/ai/agents/rota-de-ensaio.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { testRunSchema } from "@/lib/ai/agents/validation";
import { classificarFalhaDoEnsaio } from "@/lib/ai/agents/ensaio-falha";
import { montarPayloadDoEnsaio } from "@/lib/ai/agents/ensaio-resultado";
import { ensurePlatformPlaybook } from "@/lib/agent-engine/agent/playbook-ensure";
import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { traduzir } from "@/lib/i18n/dicionario";

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

  // Seed DEPOIS do INSERT: se o playbook falhar, o run existe e fecha como
  // `failed` — a aba Execuções vê a tentativa. Seed ANTES criaria 422 sem rastro.
  const log = createLogger();
  let resultPayload: Record<string, unknown>;

  try {
    const pool = getRequestPool();
    const deps = requestTurnDeps();
    await ensurePlatformPlaybook(pool, deps.log ?? log, { origem: "ensaio" });
    const result = await testAgentVersion(pool, deps, {
      organizationId: activeOrg.orgId,
      agentId: id,
      versionId: vid,
      runId: runRow.id,
      sampleMessage: parsed.data.sample_message,
      sampleContact: parsed.data.sample_contact,
      channelId: version.channel_session_id,
    });
    resultPayload = montarPayloadDoEnsaio(runRow.id, result, {
      stub: process.env.INTERNAL_AGENT_RUN_STUB === "true",
      wallMs: Date.now() - startedAt.getTime(),
    });
    const fechou = await encerrarRunDoEnsaio(admin, {
      orgId: activeOrg.orgId,
      runId: runRow.id,
      status: "completed",
      toolCalls: {
        offered: result.tools_offered,
        called: result.tools_called,
      },
      stepsCount: result.steps_count,
      tokensIn: result.tokens_in,
      tokensOut: result.tokens_out,
      costCents: typeof resultPayload.cost_cents === "number" ? resultPayload.cost_cents : result.cost_cents,
      latencyMs: typeof resultPayload.latency_ms === "number" ? resultPayload.latency_ms : null,
    });
    if (!fechou) {
      log.error("ensaio: checkpoint nao gravado", { code: "completed" });
    }
  } catch (err) {
    const classificado = classificarFalhaDoEnsaio(err);
    const fechou = await encerrarRunDoEnsaio(admin, {
      orgId: activeOrg.orgId,
      runId: runRow.id,
      status: "failed",
      errorCode: classificado.code,
      errorMessage: classificado.message,
    });
    if (!fechou) {
      log.error("ensaio: checkpoint nao gravado", { code: classificado.code });
    }
    return fail(classificado.code, t(classificado.message), 422, { requestId });
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

type AdminDoEnsaio = ReturnType<typeof createAdminClient>;

async function encerrarRunDoEnsaio(
  admin: AdminDoEnsaio,
  args: {
    orgId: string;
    runId: string;
    status: "completed" | "failed";
    errorCode?: string;
    errorMessage?: string;
    toolCalls?: unknown;
    stepsCount?: number;
    tokensIn?: number;
    tokensOut?: number;
    costCents?: number;
    latencyMs?: number | null;
  },
): Promise<boolean> {
  const patch: Record<string, unknown> = {
    status: args.status,
    completed_at: new Date().toISOString(),
  };
  if (args.errorCode) patch.error_code = args.errorCode;
  if (args.errorMessage) patch.error_message = args.errorMessage;
  if (args.toolCalls !== undefined) patch.tool_calls = args.toolCalls;
  if (args.stepsCount !== undefined) patch.steps_count = args.stepsCount;
  if (args.tokensIn !== undefined) patch.tokens_in = args.tokensIn;
  if (args.tokensOut !== undefined) patch.tokens_out = args.tokensOut;
  if (args.costCents !== undefined) patch.cost_cents = args.costCents;
  if (args.latencyMs !== undefined && args.latencyMs !== null) patch.latency_ms = args.latencyMs;
  const { error } = await admin
    .from("ai_agent_runs")
    .update(patch)
    .eq("organization_id", args.orgId)
    .eq("id", args.runId);
  return !error;
}
