/**
 * Finalize/persist helpers for the agent runtime (S-13.08).
 *
 * `finalizeRun` stamps the row, emits domain event + audit log.
 * `sendFinalResponse` reuses `sendMessageHandler` (which knows about WAHA,
 * outbound row insert, retry, idempotency_keys) so we never duplicate
 * dispatch logic here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SerializedStep } from "./serialize";

export type RunStatus = "completed" | "failed" | "aborted" | "handoff";

export interface FinalizeRunInput {
  runId: string;
  organizationId: string;
  status: RunStatus;
  tokensIn?: number;
  tokensOut?: number;
  /** `null` = custo desconhecido (modelo sem preço). Nunca inventar 0. */
  costCents?: number | null;
  latencyMs?: number;
  stepsCount?: number;
  toolCalls?: SerializedStep[];
  finalText?: string | null;
  outboundMessageId?: string | null;
  abortReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  isDryRun?: boolean;
}

export async function finalizeRun(input: FinalizeRunInput): Promise<void> {
  const admin = createAdminClient();
  const completedAt = new Date().toISOString();

  const updateRow: Record<string, unknown> = {
    status: input.status,
    completed_at: completedAt,
  };
  if (input.tokensIn !== undefined) updateRow.tokens_in = input.tokensIn;
  if (input.tokensOut !== undefined) updateRow.tokens_out = input.tokensOut;
  if (input.costCents !== undefined) updateRow.cost_cents = input.costCents;
  if (input.latencyMs !== undefined) updateRow.latency_ms = input.latencyMs;
  if (input.stepsCount !== undefined) updateRow.steps_count = input.stepsCount;
  if (input.toolCalls !== undefined) updateRow.tool_calls = input.toolCalls;
  if (input.outboundMessageId !== undefined) updateRow.outbound_message_id = input.outboundMessageId;
  if (input.abortReason !== undefined) updateRow.abort_reason = input.abortReason;
  if (input.errorCode !== undefined) updateRow.error_code = input.errorCode;
  if (input.errorMessage !== undefined) {
    updateRow.error_message = (input.errorMessage ?? "").slice(0, 500);
  }

  await admin
    .from("ai_agent_runs")
    .update(updateRow)
    .eq("id", input.runId)
    .eq("organization_id", input.organizationId);

  // Domain event (best-effort).
  const eventType =
    input.status === "completed"
      ? "ai_agent.run_completed"
      : input.status === "handoff"
        ? "ai_agent.handoff_triggered"
        : "ai_agent.run_failed";

  await admin.rpc("emit_event" as never, {
    p_event_type: eventType,
    p_entity_kind: "ai_agent_run",
    p_entity_id: input.runId,
    p_payload: {
      run_id: input.runId,
      status: input.status,
      tokens_in: input.tokensIn ?? 0,
      tokens_out: input.tokensOut ?? 0,
      cost_cents: input.costCents ?? null,
      latency_ms: input.latencyMs ?? null,
      steps_count: input.stepsCount ?? 0,
      abort_reason: input.abortReason ?? null,
      is_dry_run: input.isDryRun ?? false,
    },
    p_metadata: { source: "agent-runtime" },
    p_organization_id: input.organizationId,
  } as never);

  // Audit log (fire-and-forget).
  const auditAction =
    input.status === "completed" || input.status === "handoff"
      ? "ai_agent.run_completed"
      : "ai_agent.run_failed";
  void audit({
    action: auditAction,
    organizationId: input.organizationId,
    resourceType: "ai_agent_run",
    resourceId: input.runId,
    metadata: {
      status: input.status,
      abort_reason: input.abortReason ?? null,
      error_code: input.errorCode ?? null,
      tokens_in: input.tokensIn ?? 0,
      tokens_out: input.tokensOut ?? 0,
      cost_cents: input.costCents ?? null,
      latency_ms: input.latencyMs ?? null,
      steps_count: input.stepsCount ?? 0,
      is_dry_run: input.isDryRun ?? false,
    },
  });
}

export interface SendFinalResponseInput {
  supabase: SupabaseClient;
  organizationId: string;
  runId: string;
  /**
   * A linha em `ai_agents`. Separado de `runId` pela mesma razão do `Actor`:
   * `id` correlaciona no audit e varia por runtime, `agent_id` é a única coisa
   * que pode ir para coluna com FK. Ver `Actor` em lib/api/handlers/types.ts.
   */
  agentId: string;
  conversationId: string;
  text: string;
  requestId: string;
}

/**
 * Inserts an outbound message + dispatches via WAHA via existing
 * sendMessageHandler. Returns the new message id (or null on failure).
 */
export async function sendFinalResponse(
  input: SendFinalResponseInput,
): Promise<string | null> {
  if (!input.text || input.text.trim().length === 0) return null;

  const actor: Actor = {
    type: "ai_agent",
    id: input.runId,
    agent_id: input.agentId,
    role: "ai_operator",
  };
  try {
    const message = await sendMessageHandler(
      input.supabase,
      {
        organization_id: input.organizationId,
        actor,
        requestId: input.requestId,
      },
      {
        conversation_id: input.conversationId,
        type: "text",
        body: input.text,
        metadata: { run_id: input.runId, ai_actor_id: input.runId },
      },
    );
    return message.id;
  } catch (err) {
    console.error("[agent-runtime] sendFinalResponse failed", err);
    return null;
  }
}
