/**
 * ai-sentiment-worker — classifies the sentiment of inbound messages.
 *
 * Consumes `message.received` events (parallel to ai-response-worker).
 * Uses `anthropic/claude-haiku-4-5` via Vercel AI Gateway with generateObject
 * and a strict Zod schema so the result is always typed.
 *
 * Design principles (CLAUDE.md):
 * - Service-role admin client bypasses RLS → EVERY query filters `organization_id`
 *   programmatically from the trusted event_log row, never from user input.
 * - Any failure is swallowed (try/catch global) so the bot path in
 *   ai-response-worker keeps running unaffected.
 * - `console.log` is forbidden — only `console.warn`/`console.error` with prefix.
 */

import { generateObject } from "ai";
import { z } from "zod";

import { computeCost } from "@/lib/ai/cost";
import { DEFAULT_CLASSIFIER_MODEL, isAiGatewayConfigured } from "@/lib/ai/gateway";
import { logInvocation } from "@/lib/ai/log-invocation";
import { SENTIMENT_SYSTEM_PROMPT } from "@/lib/ai/prompts/sentiment";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

const SENTIMENT_MODEL = DEFAULT_CLASSIFIER_MODEL; // "anthropic/claude-haiku-4-5"
const DEFAULT_SENTIMENT_THRESHOLD = 0.3;
const CLASSIFY_TIMEOUT_MS = 5_000;

const sentimentSchema = z.object({
  sentiment_score: z.number().min(0).max(1),
  reasoning_short: z.string().max(100),
});

export interface SentimentResult {
  skipped: boolean;
  reason?: string;
  sentiment_score?: number;
}

export async function processSentiment(event: EventRow): Promise<SentimentResult> {
  try {
    // ── Guard: AI Gateway configured ────────────────────────────────────────
    if (!isAiGatewayConfigured()) {
      return { skipped: true, reason: "ai_gateway_key_missing" };
    }

    const messageId = (event.payload?.["message_id"] as string | undefined) ?? event.entity_id ?? null;
    const conversationId = (event.payload?.["conversation_id"] as string | undefined) ?? null;
    if (!messageId) {
      return { skipped: true, reason: "missing_message_id" };
    }

    const admin = createAdminClient();

    // ── Load message (programmatic org filter) ────────────────────────────
    const { data: message, error: msgErr } = await admin
      .from("messages")
      .select("id, body, direction, conversation_id, organization_id, metadata")
      .eq("id", messageId)
      .eq("organization_id", event.organization_id)
      .maybeSingle();

    if (msgErr || !message) {
      return { skipped: true, reason: "message_not_found" };
    }

    // ── Guard: inbound only ───────────────────────────────────────────────
    if (message.direction !== "inbound") {
      return { skipped: true, reason: "not_inbound" };
    }

    // ── Guard: non-empty body ─────────────────────────────────────────────
    const body = (message.body ?? "").trim();
    if (!body) {
      return { skipped: true, reason: "empty_body" };
    }

    // ── Load active agent to read sentiment_threshold config ──────────────
    const { data: agent } = await admin
      .from("ai_agents")
      .select("id, config")
      .eq("organization_id", event.organization_id)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const agentConfig = (agent?.config as Record<string, unknown> | null) ?? {};
    const threshold =
      typeof agentConfig["sentiment_threshold"] === "number"
        ? agentConfig["sentiment_threshold"]
        : DEFAULT_SENTIMENT_THRESHOLD;

    // ── Call LLM ──────────────────────────────────────────────────────────
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), CLASSIFY_TIMEOUT_MS);

    const start = Date.now();
    let result: z.infer<typeof sentimentSchema>;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const generated = await generateObject({
        model: SENTIMENT_MODEL,
        schema: sentimentSchema,
        system: SENTIMENT_SYSTEM_PROMPT,
        prompt: body,
        temperature: 0,
        maxOutputTokens: 80,
        abortSignal: abortController.signal,
      });

      result = generated.object;

      const usage = generated.usage as
        | {
            inputTokens?: number;
            outputTokens?: number;
            promptTokens?: number;
            completionTokens?: number;
          }
        | undefined;
      promptTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
      completionTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - start;

    // ── Merge sentiment into messages.metadata ────────────────────────────
    const existingMetadata = (message.metadata as Record<string, unknown> | null) ?? {};
    const updatedMetadata = {
      ...existingMetadata,
      sentiment_score: result.sentiment_score,
      sentiment_latency_ms: latencyMs,
    };

    const { error: updateErr } = await admin
      .from("messages")
      .update({ metadata: updatedMetadata })
      .eq("id", messageId)
      .eq("organization_id", event.organization_id);

    if (updateErr) {
      console.warn("[ai-sentiment-worker] metadata update failed", {
        message_id: messageId,
        error: updateErr.message,
      });
    }

    // ── Log invocation (fire-and-forget) ──────────────────────────────────
    logInvocation({
      organization_id: event.organization_id,
      agent_id: agent?.id ?? "",
      conversation_id: conversationId ?? message.conversation_id ?? null,
      message_id: messageId,
      invocation_kind: "sentiment_classify",
      model: SENTIMENT_MODEL,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      latency_ms: latencyMs,
      cost_cents: await computeCost({
        model: SENTIMENT_MODEL,
        promptTokens,
        completionTokens,
      }),
      finish_reason: null,
    });

    // ── Emit alert if below threshold ────────────────────────────────────
    if (result.sentiment_score < threshold) {
      const { error: emitErr } = await admin.rpc("emit_event" as never, {
        p_event_type: "ai.sentiment_alert",
        p_entity_kind: "message",
        p_entity_id: messageId,
        p_payload: {
          message_id: messageId,
          conversation_id: conversationId ?? message.conversation_id ?? null,
          sentiment_score: result.sentiment_score,
        },
        p_metadata: { source: "ai-sentiment-worker", threshold },
        p_organization_id: event.organization_id,
      } as never);

      if (emitErr) {
        console.warn("[ai-sentiment-worker] ai.sentiment_alert emit failed", {
          message_id: messageId,
          error: emitErr.message,
        });
      }
    }

    return { skipped: false, sentiment_score: result.sentiment_score };
  } catch (err) {
    // Global catch: NEVER throw — must not break the bot path.
    console.warn("[ai-sentiment-worker] sentiment_classify_failed", {
      event_id: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { skipped: true, reason: "classify_failed" };
  }
}
