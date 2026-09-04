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
  | "assigned_to_human"
  | "window_24h_expired"
  /**
   * O teto mensal de gasto com IA foi atingido e a organização escolheu que a
   * IA parasse. Chamava-se `budget_throttled` enquanto o guard lia
   * `ai_budgets.is_throttled` — flag que perdeu o escritor e foi aposentada; o
   * nome agora é o mesmo do `agent_inbox_items.kind` que explica a parada na
   * Central e o da classe `LlmBudgetExceededError` do engine, para que a mesma
   * coisa tenha um nome só nos dois caminhos.
   */
  | "budget_exceeded"
  | "silenced_post_handoff"
  | "handoff_recent"
  | "conversation_not_found"
  | "empty_inbound_body"
  | "duplicate_outbound"
  /**
   * A organização tem agente PUBLICADO, e quem responde publicado é o
   * agent-engine (issue #129). Este worker é o caminho pré-engine: ele não
   * chega a enviar nada — insere a outbound como `sending` e emite
   * `message.send_requested`, que NUNCA teve consumidor. Sem esta trava os dois
   * rodam na mesma mensagem: o engine responde de verdade e este aqui gasta
   * token à toa e deixa uma linha presa para sempre no inbox de quem instalou.
   */
  | "engine_owns_reply"
  /**
   * O canal tem o gate de elegibilidade ligado (`channel_sessions.metadata.ai_gate
   * = 'allowlist'`) e o contato NÃO foi autorizado por uma origem elegível
   * (webhook do Respondi, match de campanha, ação de automação, retomada manual)
   * — ou a autorização expirou. Este worker legado passa pela MESMA regra pura
   * (`lib/ai/elegibilidade/gate.ts`) que o drain e o turno do agent-engine: não
   * pode existir um caminho alternativo que responda uma conversa não
   * autorizada. Também cai aqui quando a leitura da elegibilidade falha —
   * fail-closed, porque schema pela metade é exatamente quando não se quer a IA
   * solta.
   */
  | "nao_elegivel_para_ia";

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
