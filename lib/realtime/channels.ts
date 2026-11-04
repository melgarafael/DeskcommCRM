/**
 * Canonical realtime channel factory helpers.
 * Centralizes channel-name strings so every consumer stays in sync.
 */

import { createClient } from "@/lib/supabase/browser";

/**
 * Platform-wide alerts broadcast channel.
 * Legacy compatibility export; not used for sensitive product notices.
 * Sensitive product notices use useNoticeSignal plus authorized REST instead.
 */
export function alertsPlatform() {
  return createClient().channel("alerts-platform");
}
