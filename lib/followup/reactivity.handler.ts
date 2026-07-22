/**
 * Adapter fino que pluga `applyReactivityEvent` (lib/followup/reactivity.ts)
 * no dispatcher genérico do event_log — mesmo padrão de
 * `workers/ai-response-worker.handler.ts` (handler key isolado do pipeline,
 * pra não puxar o registry pra dentro dos testes unit do pipeline puro).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyReactivityEvent, createSupabaseReactivityClient } from "@/lib/followup/reactivity";

export const FOLLOWUP_REACTIVITY_HANDLER_KEY = "followup-reactivity.v1";

export const followupReactivityHandler: EventHandler = {
  key: FOLLOWUP_REACTIVITY_HANDLER_KEY,
  events: ["message.received", "ai.handoff_triggered", "ai.handoff_resolved"],
  async handle(row): Promise<HandlerResult> {
    try {
      const db = createSupabaseReactivityClient(createAdminClient());
      const summary = await applyReactivityEvent(db, () => new Date(), row);
      return {
        consumer_key: FOLLOWUP_REACTIVITY_HANDLER_KEY,
        status: summary.matched ? "ok" : "skipped",
        detail: `reacted=${summary.reacted}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FOLLOWUP_REACTIVITY_HANDLER_KEY, status: "error", detail };
    }
  },
};
