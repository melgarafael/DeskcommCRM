/**
 * Adapter fino que pluga `agendarRetomadaAoDevolver` no dispatcher do
 * `event_log`. Consome o MESMO `ai.handoff_resolved` que retoma os follow-ups
 * pausados (`followup-reactivity.v1`) — por isso a decisão cede a vez quando
 * há acompanhamento vivo: uma voz só.
 *
 * `naOrgParada: "pula"`: o desfecho é uma mensagem ao cliente, que custa e sai
 * para fora.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

import {
  agendarRetomadaAoDevolver,
  createSupabaseRetomadaAoDevolverDb,
} from "./retomada-ao-devolver";

export const RETOMADA_AO_DEVOLVER_HANDLER_KEY = "retomada-ao-devolver.v1";

export const retomadaAoDevolverHandler: EventHandler = {
  key: RETOMADA_AO_DEVOLVER_HANDLER_KEY,
  naOrgParada: "pula",
  events: ["ai.handoff_resolved"],
  async handle(row): Promise<HandlerResult> {
    const conversationId =
      typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null;
    if (conversationId === null) {
      return { consumer_key: RETOMADA_AO_DEVOLVER_HANDLER_KEY, status: "skipped", detail: "sem_conversa" };
    }
    try {
      const desfecho = await agendarRetomadaAoDevolver(
        createSupabaseRetomadaAoDevolverDb(createAdminClient()),
        { organizationId: row.organization_id, conversationId, eventId: row.id },
      );
      const detail = desfecho.kind === "pulado" ? `pulado:${desfecho.motivo}` : desfecho.kind;
      if (desfecho.kind === "enfileirado") {
        logger.info("[escalacao.retomada-ao-devolver] turno de retomada enfileirado", {
          organization_id: row.organization_id,
          conversation_id: conversationId,
          event_id: row.id,
        });
      }
      return {
        consumer_key: RETOMADA_AO_DEVOLVER_HANDLER_KEY,
        status: desfecho.kind === "enfileirado" ? "ok" : "skipped",
        detail,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: RETOMADA_AO_DEVOLVER_HANDLER_KEY, status: "error", detail };
    }
  },
};
