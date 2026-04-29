/**
 * Fire-and-forget insert into `ai_invocations`.
 *
 * Caller should NOT await. We use `queueMicrotask` so the parent handler can
 * return without waiting for the audit insert; failures bubble to logger only.
 */

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export interface LogInvocationInput {
  organization_id: string;
  agent_id: string;
  conversation_id: string | null;
  message_id: string | null;
  invocation_kind:
    | "bot_respond"
    | "sentiment_check"
    | "embed_chunk"
    | "embed_query"
    | "intent_classify";
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_cents: number;
  finish_reason?: string | null;
  citations?: Array<Record<string, unknown>>;
  error_payload?: Record<string, unknown> | null;
}

export function logInvocation(row: LogInvocationInput): void {
  queueMicrotask(() => {
    void (async () => {
      try {
        const admin = createAdminClient();
        const { error } = await admin.from("ai_invocations").insert({
          organization_id: row.organization_id,
          agent_id: row.agent_id,
          conversation_id: row.conversation_id,
          message_id: row.message_id,
          invocation_kind: row.invocation_kind,
          model: row.model,
          prompt_tokens: row.prompt_tokens,
          completion_tokens: row.completion_tokens,
          latency_ms: row.latency_ms,
          cost_cents: row.cost_cents,
          finish_reason: row.finish_reason ?? null,
          citations: row.citations ?? [],
          error_payload: row.error_payload ?? null,
        });
        if (error) {
          logger.warn("[ai-invocations] insert failed", {
            error: error.message,
            organization_id: row.organization_id,
            invocation_kind: row.invocation_kind,
          });
        }
      } catch (err) {
        logger.warn("[ai-invocations] insert threw", {
          error: err instanceof Error ? err.message : String(err),
          organization_id: row.organization_id,
        });
      }
    })();
  });
}
