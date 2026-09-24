/**
 * Handoff finalizer for the agent runtime (S-13.08).
 *
 * Wraps lib/ai/handoff/orchestrator.triggerHandoff and stamps the run row with
 * status='handoff'. Two sources:
 *   - 'sentinel'         keyword regex on inbound (no LLM call, cost=0)
 *   - 'tool'             agent invoked crm_request_human_handoff during the loop
 */
import { triggerHandoff, type HandoffReason } from "@/lib/ai/handoff/orchestrator";
import { createAdminClient } from "@/lib/supabase/admin";
import { finalizeRun, type FinalizeRunInput } from "./finalize";

export type HandoffSource = "sentinel" | "tool";

export interface FinalizeHandoffInput {
  runId: string;
  organizationId: string;
  conversationId: string | null;
  reason: HandoffReason;
  source: HandoffSource;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costCents?: number | null;
  stepsCount?: number;
  toolCalls?: FinalizeRunInput["toolCalls"];
  isDryRun?: boolean;
}

async function findLeadIdForConversation(
  organizationId: string,
  conversationId: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("crm_lead_links")
    .select("lead_id")
    .eq("organization_id", organizationId)
    .eq("target_kind", "conversation")
    .eq("target_id", conversationId)
    .maybeSingle();
  return (data?.lead_id as string | undefined) ?? null;
}

export async function finalizeHandoff(input: FinalizeHandoffInput): Promise<void> {
  // Trigger external side effects only when we have a real conversation
  // (test/dry-run flows pass null and just want the run row marked).
  if (input.conversationId && !input.isDryRun) {
    const leadId = await findLeadIdForConversation(input.organizationId, input.conversationId);
    await triggerHandoff({
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      reason: input.reason,
      origem: "runtime_nativo",
      leadId,
      metadata: { run_id: input.runId, source: input.source },
    });
  }

  await finalizeRun({
    runId: input.runId,
    organizationId: input.organizationId,
    status: "handoff",
    abortReason: `${input.source}:${input.reason}`,
    latencyMs: input.latencyMs,
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    costCents: input.costCents ?? null,
    stepsCount: input.stepsCount ?? 0,
    toolCalls: input.toolCalls,
    isDryRun: input.isDryRun,
  });
}
