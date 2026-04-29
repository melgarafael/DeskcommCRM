/**
 * ai-response-worker — pipeline that consumes `message.received` events and
 * produces an AI-generated outbound message + `message.send_requested` event.
 *
 * Pipeline:
 *   1. buildContext   — load conversation, agent, contact, recent messages, RAG hits
 *   2. checkGuards    — IA-01..IA-08 (24h window, blocked, force_human, budget, handoff)
 *   3. invokeBot      — call `anthropic/claude-sonnet-4-6` via Vercel AI Gateway
 *   4. postProcess    — trim, basic guardrails (placeholder for sentiment/handoff hooks)
 *   5. persistAndDispatch — insert outbound message (status='sending') + emit event
 *
 * Service-role caveat (CLAUDE.md §multi-tenancy): admin client bypasses RLS,
 * so EVERY query in this file filters `organization_id` programmatically using
 * `row.organization_id` (from the trusted event_log row, not user input).
 */

import { generateText } from "ai";

import {
  DEFAULT_BOT_MODEL,
  gatewayConfig,
  gatewayHeaders,
  isAiGatewayConfigured,
  isEmbeddingProviderConfigured,
} from "@/lib/ai/gateway";
import { embedText } from "@/lib/ai/embed";
import { computeCost } from "@/lib/ai/cost";
import { logInvocation } from "@/lib/ai/log-invocation";
import { renderSystemPrompt } from "@/lib/ai/render-system-prompt";
import type {
  BotContext,
  BotResponse,
  Citation,
  GuardDecision,
  RagHit,
  RecentMessage,
  SkipDecision,
} from "@/lib/ai/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const RECENT_MESSAGES_LIMIT = 20;
const RAG_TOP_K = 5;
const RAG_THRESHOLD = 0.72;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const HANDOFF_RECENT_GUARD_MS = 5_000;

export interface ProcessResult {
  status: "sent_to_dispatch" | "skipped" | "error";
  reason?: string;
  detail?: string;
  outbound_message_id?: string;
}

export async function processMessageReceived(row: EventRow): Promise<ProcessResult> {
  // Cheap pre-check before doing any DB work.
  if (!isAiGatewayConfigured()) {
    return { status: "skipped", reason: "ai_gateway_key_missing" };
  }

  const messageId = (row.payload?.["message_id"] as string | undefined) ?? row.entity_id ?? null;
  const conversationId = (row.payload?.["conversation_id"] as string | undefined) ?? null;
  if (!messageId || !conversationId) {
    return {
      status: "skipped",
      reason: "conversation_not_found",
      detail: "missing message_id/conversation_id in event payload",
    };
  }

  const decision = await buildContext({
    organizationId: row.organization_id,
    conversationId,
    messageId,
  });

  if (decision.kind === "skip") {
    logger.info("[ai-response-worker] skip", {
      reason: decision.reason,
      detail: decision.detail,
      conversation_id: conversationId,
      message_id: messageId,
    });
    return { status: "skipped", reason: decision.reason, detail: decision.detail };
  }

  const ctx = decision.context;
  try {
    const response = await invokeBot(ctx);
    const post = postProcess(response.text);
    const persisted = await persistAndDispatch(ctx, response, post.text);
    logInvocation({
      organization_id: ctx.organization_id,
      agent_id: ctx.agent.id,
      conversation_id: ctx.conversation_id,
      message_id: persisted.outbound_message_id,
      invocation_kind: "bot_respond",
      model: ctx.agent.model,
      prompt_tokens: response.prompt_tokens,
      completion_tokens: response.completion_tokens,
      latency_ms: response.latency_ms,
      cost_cents: await computeCost({
        model: ctx.agent.model,
        promptTokens: response.prompt_tokens,
        completionTokens: response.completion_tokens,
      }),
      finish_reason: response.finish_reason,
      citations: response.citations as unknown as Array<Record<string, unknown>>,
    });
    return { status: "sent_to_dispatch", outbound_message_id: persisted.outbound_message_id };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[ai-response-worker] invocation failed", {
      conversation_id: ctx.conversation_id,
      message_id: ctx.message_id,
      error: detail,
    });
    logInvocation({
      organization_id: ctx.organization_id,
      agent_id: ctx.agent.id,
      conversation_id: ctx.conversation_id,
      message_id: ctx.message_id,
      invocation_kind: "bot_respond",
      model: ctx.agent.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: 0,
      cost_cents: 0,
      finish_reason: "error",
      error_payload: { message: detail },
    });
    return { status: "error", detail };
  }
}

// ---------------------------------------------------------------------------
// 1. buildContext + 2. checkGuards (combined — guards inspect data we already
//    have to fetch for context, so they share the same query set).
// ---------------------------------------------------------------------------

interface BuildContextInput {
  organizationId: string;
  conversationId: string;
  messageId: string;
}

async function buildContext(input: BuildContextInput): Promise<GuardDecision> {
  const admin = createAdminClient();

  // Conversation + contact + agent in 2 round trips. Service-role bypasses RLS,
  // so org filter is mandatory on every where-clause.
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select(
      "id, organization_id, contact_id, channel_session_id, last_inbound_at, bot_silenced_until, last_handoff_at, contacts:contact_id(id, display_name, locale, is_blocked, force_human)",
    )
    .eq("id", input.conversationId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (convErr) return skip("conversation_not_found", convErr.message);
  if (!conv) return skip("conversation_not_found");

  type ConvRow = {
    id: string;
    organization_id: string;
    contact_id: string;
    channel_session_id: string;
    last_inbound_at: string | null;
    bot_silenced_until: string | null;
    last_handoff_at: string | null;
    contacts: {
      id: string;
      display_name: string | null;
      locale: string | null;
      is_blocked: boolean;
      force_human: boolean;
    } | null;
  };
  const c = conv as unknown as ConvRow;
  if (!c.contacts) return skip("conversation_not_found", "contact join missing");
  if (c.contacts.is_blocked) return skip("contact_blocked");
  if (c.contacts.force_human) return skip("force_human");

  // 24h window (IA-01). Use last_inbound_at — webhook updates it on receive.
  if (c.last_inbound_at) {
    const age = Date.now() - new Date(c.last_inbound_at).getTime();
    if (age > WINDOW_24H_MS) return skip("window_24h_expired");
  }
  // Post-handoff silence (IA-06)
  if (c.bot_silenced_until && new Date(c.bot_silenced_until).getTime() > Date.now()) {
    return skip("silenced_post_handoff");
  }
  // Recent handoff (idempotency for S-06.03)
  if (c.last_handoff_at) {
    const since = Date.now() - new Date(c.last_handoff_at).getTime();
    if (since < HANDOFF_RECENT_GUARD_MS) return skip("handoff_recent");
  }

  // Inbound message body (the trigger payload doesn't carry it).
  const { data: msg, error: msgErr } = await admin
    .from("messages")
    .select("id, body, direction, organization_id")
    .eq("id", input.messageId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (msgErr) return skip("conversation_not_found", msgErr.message);
  if (!msg) return skip("conversation_not_found", "message not found");
  if (msg.direction !== "inbound") return skip("duplicate_outbound");
  const inbound_body = (msg.body ?? "").trim();
  if (!inbound_body) return skip("empty_inbound_body");

  // Default agent for this tenant.
  const { data: agent } = await admin
    .from("ai_agents")
    .select(
      "id, organization_id, model, system_prompt, config, guardrails, active_kb_version_id, is_active, is_default",
    )
    .eq("organization_id", input.organizationId)
    .eq("is_active", true)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!agent) return skip("agent_inactive_or_missing");
  if (!agent.active_kb_version_id) return skip("kb_version_missing");

  // Budget guard (IA-02)
  const { data: budget } = await admin
    .from("ai_budgets")
    .select("organization_id, is_throttled, is_disabled")
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (budget?.is_throttled || budget?.is_disabled) return skip("budget_throttled");

  // Recent messages (chronological, last RECENT_MESSAGES_LIMIT)
  const { data: recents } = await admin
    .from("messages")
    .select("id, body, direction, created_at")
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .order("created_at", { ascending: false })
    .limit(RECENT_MESSAGES_LIMIT);
  const recent_messages: RecentMessage[] = ((recents ?? []) as RecentMessage[])
    .slice()
    .reverse();

  // RAG retrieval (best-effort — empty list when embedding provider missing)
  const retrieved_chunks = await retrieveContext({
    organizationId: input.organizationId,
    kbVersionId: agent.active_kb_version_id,
    query: inbound_body,
  });

  return {
    kind: "proceed",
    context: {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      contact_id: c.contact_id,
      channel_session_id: c.channel_session_id,
      message_id: input.messageId,
      inbound_body,
      recent_messages,
      agent: {
        id: agent.id,
        model: agent.model || DEFAULT_BOT_MODEL,
        system_prompt: agent.system_prompt,
        config: (agent.config as Record<string, unknown>) ?? {},
        guardrails: (agent.guardrails as Record<string, unknown>) ?? {},
        active_kb_version_id: agent.active_kb_version_id,
      },
      contact: {
        id: c.contacts.id,
        display_name: c.contacts.display_name,
        locale: c.contacts.locale,
      },
      retrieved_chunks,
    },
  };
}

function skip(reason: SkipDecision["reason"], detail?: string): SkipDecision {
  return { kind: "skip", reason, detail };
}

interface RetrieveInput {
  organizationId: string;
  kbVersionId: string;
  query: string;
}

async function retrieveContext(input: RetrieveInput): Promise<RagHit[]> {
  if (!isEmbeddingProviderConfigured()) return [];
  let embedding: number[];
  try {
    const { embedding: e } = await embedText(input.query, {
      organizationId: input.organizationId,
    });
    embedding = e;
  } catch (err) {
    logger.warn("[ai-response-worker] embed failed; proceeding without RAG", {
      error: err instanceof Error ? err.message : String(err),
      organization_id: input.organizationId,
    });
    return [];
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("retrieve_top_k_chunks" as never, {
    p_organization_id: input.organizationId,
    p_kb_version_id: input.kbVersionId,
    p_embedding: embedding as unknown as string,
    p_k: RAG_TOP_K,
    p_threshold: RAG_THRESHOLD,
  } as never);

  if (error) {
    logger.warn("[ai-response-worker] retrieve_top_k_chunks failed", {
      error: error.message,
      organization_id: input.organizationId,
    });
    return [];
  }
  type RpcRow = {
    chunk_id: string;
    knowledge_source_id: string;
    content: string;
    similarity: number;
    metadata: Record<string, unknown> | null;
  };
  return ((data ?? []) as RpcRow[]).map((r) => ({
    chunk_id: r.chunk_id,
    knowledge_source_id: r.knowledge_source_id,
    content: r.content,
    similarity: r.similarity,
    metadata: r.metadata ?? {},
  }));
}

// ---------------------------------------------------------------------------
// 3. invokeBot
// ---------------------------------------------------------------------------

async function invokeBot(ctx: BotContext): Promise<BotResponse> {
  const renderedSystem = renderSystemPrompt(ctx.agent.system_prompt, ctx);
  const cfg = gatewayConfig();
  const headers = cfg ? gatewayHeaders({ organizationId: ctx.organization_id }) : undefined;

  // Build a chronological multi-turn message history. The most recent inbound
  // is the implicit final user turn; we also include it explicitly to be safe.
  const messages = ctx.recent_messages
    .filter((m) => (m.body ?? "").trim().length)
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: (m.body ?? "").trim(),
    }));
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || last.content !== ctx.inbound_body) {
    messages.push({ role: "user", content: ctx.inbound_body });
  }

  const start = Date.now();
  const result = await generateText({
    model: ctx.agent.model,
    system: renderedSystem,
    messages,
    headers,
  });
  const latency = Date.now() - start;

  const usage = result.usage as
    | {
        inputTokens?: number;
        outputTokens?: number;
        promptTokens?: number;
        completionTokens?: number;
      }
    | undefined;
  const promptTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;

  const citations: Citation[] = ctx.retrieved_chunks.map((c) => ({
    chunk_id: c.chunk_id,
    knowledge_source_id: c.knowledge_source_id,
    similarity: c.similarity,
    preview: c.content.slice(0, 200),
  }));

  return {
    text: result.text,
    finish_reason: String(result.finishReason ?? "unknown"),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    latency_ms: latency,
    citations,
  };
}

// ---------------------------------------------------------------------------
// 4. postProcess — minimal at wave 1; sentiment/handoff stubs land in S-06.02/03
// ---------------------------------------------------------------------------

function postProcess(text: string): { text: string; flags: string[] } {
  const trimmed = text.trim();
  // Hard cap to avoid sending wall-of-text. WhatsApp soft-limit is ~4096; keep headroom.
  const capped = trimmed.length > 3500 ? `${trimmed.slice(0, 3500).trimEnd()}…` : trimmed;
  return { text: capped, flags: [] };
}

// ---------------------------------------------------------------------------
// 5. persistAndDispatch
// ---------------------------------------------------------------------------

async function persistAndDispatch(
  ctx: BotContext,
  response: BotResponse,
  finalText: string,
): Promise<{ outbound_message_id: string }> {
  const admin = createAdminClient();

  const insertRow = {
    organization_id: ctx.organization_id,
    conversation_id: ctx.conversation_id,
    channel_session_id: ctx.channel_session_id,
    contact_id: ctx.contact_id,
    type: "text",
    direction: "outbound" as const,
    status: "sending",
    body: finalText,
    sent_via: "bot" as const,
    sent_at: new Date().toISOString(),
    metadata: {
      ai_generated: true,
      agent_id: ctx.agent.id,
      kb_version_id: ctx.agent.active_kb_version_id,
      finish_reason: response.finish_reason,
      citations: response.citations,
    },
  };

  const { data: inserted, error } = await admin
    .from("messages")
    .insert(insertRow)
    .select("id")
    .single();

  if (error || !inserted) {
    throw new Error(`outbound_insert_failed: ${error?.message ?? "no row returned"}`);
  }

  // Note: the trigger `trg_messages_emit_event` already emits a `message.sending`
  // event on insert. The plan requires `message.send_requested` as a distinct
  // signal for the WAHA dispatch worker — emit it explicitly so that worker
  // (S-06.x in EPIC-03 land) doesn't have to disambiguate trigger events.
  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "message.send_requested",
    p_entity_kind: "message",
    p_entity_id: inserted.id,
    p_payload: {
      message_id: inserted.id,
      conversation_id: ctx.conversation_id,
      ai_generated: true,
    },
    p_metadata: { source: "ai-response-worker" },
    p_organization_id: ctx.organization_id,
  } as never);
  if (emitErr) {
    logger.warn("[ai-response-worker] message.send_requested emit failed", {
      error: emitErr.message,
      message_id: inserted.id,
    });
  }

  // Domain event for downstream consumers (UI realtime, audit).
  void admin
    .rpc("emit_event" as never, {
      p_event_type: "ai.responded",
      p_entity_kind: "message",
      p_entity_id: inserted.id,
      p_payload: {
        message_id: inserted.id,
        conversation_id: ctx.conversation_id,
        agent_id: ctx.agent.id,
        confidence: response.citations[0] ? response.citations[0].similarity : null,
        citations: response.citations,
      },
      p_metadata: { source: "ai-response-worker" },
      p_organization_id: ctx.organization_id,
    } as never)
    .then(({ error: e }: { error: { message: string } | null }) => {
      if (e) {
        logger.warn("[ai-response-worker] ai.responded emit failed", {
          error: e.message,
          message_id: inserted.id,
        });
      }
    });

  return { outbound_message_id: inserted.id };
}
