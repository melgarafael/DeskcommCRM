/**
 * Anti-banimento mínimo p/ envio AUTOMATIZADO (spec §8): janela 7h-22h,
 * limite diário da sessão, espaçamento 1.2s+jitter. O schema de warmup já
 * existe (channel_session_warmup + channel_sessions.daily_message_limit);
 * a lógica nasce aqui. ponytail: janela fixa no fuso do servidor; janela
 * por-regra/fuso do tenant é v2.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const WINDOW_START_HOUR = 7;
const WINDOW_END_HOUR = 22;

export interface ThrottleVerdict {
  allowed: boolean;
  retry_at?: string;
  reason?: string;
}

export function withinSendWindow(now: Date = new Date()): boolean {
  const h = now.getHours();
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

export function nextWindowStart(now: Date = new Date()): string {
  const next = new Date(now);
  next.setHours(WINDOW_START_HOUR, 0, 0, 0);
  if (now.getHours() >= WINDOW_START_HOUR) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export async function checkDailyLimit(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<ThrottleVerdict> {
  const { data: session } = await admin
    .from("channel_sessions")
    .select("daily_message_limit")
    .eq("id", channelSessionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const limit = (session as { daily_message_limit?: number } | null)?.daily_message_limit ?? 300;

  const today = new Date().toISOString().slice(0, 10);
  const { data: warmup } = await admin
    .from("channel_session_warmup")
    .select("messages_sent")
    .eq("channel_session_id", channelSessionId)
    .eq("organization_id", organizationId)
    .eq("day", today)
    .maybeSingle();
  const sent = (warmup as { messages_sent?: number } | null)?.messages_sent ?? 0;

  if (sent >= limit) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(WINDOW_START_HOUR, 0, 0, 0);
    return { allowed: false, retry_at: tomorrow.toISOString(), reason: "daily_limit" };
  }
  return { allowed: true };
}

export const AUTOMATED_SEND_SPACING_MS = 1200;

export function jitterMs(): number {
  return Math.floor(Math.random() * 801);
}
