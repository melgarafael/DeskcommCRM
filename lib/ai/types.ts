/**
 * Shared shapes for the EPIC-06 AI/RAG pipeline.
 *
 * Kept in a single zero-dependency module so workers, libs, and future API
 * routes can import without dragging the AI SDK into the bundle just for types.
 */

export interface RagHit {
  chunk_id: string;
  knowledge_source_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface Citation {
  chunk_id: string;
  knowledge_source_id: string;
  similarity: number;
  /** First N chars of chunk content, for audit / UI tooltips. */
  preview: string;
}

export interface RecentMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  created_at: string;
}

/** Reasons the worker may decide to skip generating a response. */
export type SkipReason =
  | "ai_gateway_key_missing"
  | "agent_inactive_or_missing"
  | "kb_version_missing"
  | "contact_blocked"
  | "force_human"
  | "window_24h_expired"
  | "budget_throttled"
  | "silenced_post_handoff"
  | "handoff_recent"
  | "conversation_not_found"
  | "empty_inbound_body"
  | "duplicate_outbound";

export interface BotContext {
  organization_id: string;
  conversation_id: string;
  contact_id: string;
  channel_session_id: string;
  message_id: string;
  inbound_body: string;
  recent_messages: RecentMessage[];
  agent: {
    id: string;
    model: string;
    system_prompt: string;
    config: Record<string, unknown>;
    guardrails: Record<string, unknown>;
    active_kb_version_id: string | null;
  };
  contact: {
    id: string;
    display_name: string | null;
    locale: string | null;
  };
  retrieved_chunks: RagHit[];
}

export interface BotResponse {
  text: string;
  finish_reason: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  citations: Citation[];
  raw_warnings?: string[];
}

export interface PostProcessResult {
  text: string;
  /** Reasons for why post-processing changed/blocked the text. Empty when clean. */
  flags: string[];
}

export interface SkipDecision {
  kind: "skip";
  reason: SkipReason;
  detail?: string;
}

export interface ProceedDecision {
  kind: "proceed";
  context: BotContext;
}

export type GuardDecision = SkipDecision | ProceedDecision;
