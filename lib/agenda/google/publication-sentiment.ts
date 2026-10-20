import type { SupabaseClient } from "@supabase/supabase-js";
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { googleRpc } from "./sync-store";

export type PublicationSentimentPolicy = { kind: "ordinary" } | { kind: "owned" } | { kind: "retry"; retryAt: string };

/** Only the native current inbound can adopt the same reservation. The negative
 * score itself proves no customer intent. Other handoff reasons and explicit
 * human requests retain their existing paths, including semantic detection.
 */
export async function publicationSentimentPolicy(db: SupabaseClient, org: string, conversation: string, message: string,
  now = new Date()): Promise<PublicationSentimentPolicy> {
  const { data, error } = await db.from("messages").select("body,media_derived_text")
    .eq("organization_id", org).eq("conversation_id", conversation).eq("id", message).maybeSingle();
  if (error) throw new Error("google_publication_sentiment_message_unavailable");
  if (!data || detectHumanHandoffRequest(data.media_derived_text ?? data.body ?? "")) return { kind: "ordinary" };
  const context = await googleRpc(db, "fn_google_publication_sentiment_context", {
    p_org: org, p_conversation: conversation, p_message: message,
  }) as null | { owned?: boolean; wait_until?: string };
  if (context?.owned === true) return { kind: "owned" };
  const until = context?.wait_until ? Date.parse(context.wait_until) : NaN;
  if (Number.isFinite(until) && until > now.getTime() && until <= now.getTime() + 120_000)
    return { kind: "retry", retryAt: new Date(Math.min(until, now.getTime() + 5_000)).toISOString() };
  return { kind: "ordinary" };
}
