export interface Citation {
  chunk_id?: string;
  knowledge_source_id?: string | null;
  source_type?:
    | "faq"
    | "policy"
    | "conversation"
    | "conversations"
    | "catalog"
    | string;
  source_anchor?: string | null;
  score?: number; // 0..1 cosine similarity
  snippet?: string;
  text?: string; // fallback if snippet absent
  metadata?: Record<string, unknown>;
}

export function extractCitations(messageMetadata: unknown): Citation[] {
  if (!messageMetadata || typeof messageMetadata !== "object") return [];
  const m = messageMetadata as Record<string, unknown>;
  const raw = m.citations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Citation => !!c && typeof c === "object");
}

export function isAiGeneratedMessage(messageMetadata: unknown): boolean {
  if (!messageMetadata || typeof messageMetadata !== "object") return false;
  return (messageMetadata as Record<string, unknown>).ai_generated === true;
}
