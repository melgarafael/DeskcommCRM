/**
 * Adapter fino que pluga `applyReactivityEvent` (lib/followup/reactivity.ts)
 * no dispatcher genérico do event_log — mesmo padrão de
 * `workers/ai-response-worker.handler.ts` (handler key isolado do pipeline,
 * pra não puxar o registry pra dentro dos testes unit do pipeline puro).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { aplicarTextoNosFollowups, textoDoPayloadInbound } from "@/lib/followup/aplicar-inbound";
import { canalDoEventoDesativado } from "@/lib/channels/desativado";
import { applyReactivityEvent, createSupabaseReactivityClient } from "@/lib/followup/reactivity";
import { createAdminClient } from "@/lib/supabase/admin";

export const FOLLOWUP_REACTIVITY_HANDLER_KEY = "followup-reactivity.v1";

export const followupReactivityHandler: EventHandler = {
  key: FOLLOWUP_REACTIVITY_HANDLER_KEY,
  naOrgParada: "roda",
  events: ["message.received", "ai.handoff_triggered", "ai.handoff_resolved"],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      // Canal DESATIVADO (#2329): o fluxo não anda com mensagem de um canal
      // que o operador desligou — a entrega foi gravada, mas ninguém está
      // atendendo por ali. Sem a guarda, o `message.received` de um canal
      // pausado avançava o nó e gravava texto no follow-up.
      if (await canalDoEventoDesativado(admin, row.organization_id, row.payload)) {
        return {
          consumer_key: FOLLOWUP_REACTIVITY_HANDLER_KEY,
          status: "skipped",
          detail: "canal_desativado",
        };
      }
      const db = createSupabaseReactivityClient(admin);
      const summary = await applyReactivityEvent(db, () => new Date(), row);
      if (row.event_type === "message.received") {
        const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
        if (contactId) {
          await aplicarTextoNosFollowups(admin, {
            organizationId: row.organization_id,
            contactId,
            texto: textoDoPayloadInbound(row.payload) || null,
          });
        }
      }
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
