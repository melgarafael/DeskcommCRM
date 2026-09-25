/**
 * Adapter fino que pluga `aplicaGatilhoDeLead` no dispatcher do `event_log`.
 * A decisão fica em `gatilho-lead.ts`; aqui só a ligação com o client real.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import {
  EVENTO_DE_LEAD_CRIADO,
  aplicaGatilhoDeLead,
  createSupabaseGatilhoLeadDb,
} from "@/lib/followup/gatilho-lead";

export const FOLLOWUP_GATILHO_LEAD_HANDLER_KEY = "followup-gatilho-lead.v1";

export const followupGatilhoLeadHandler: EventHandler = {
  key: FOLLOWUP_GATILHO_LEAD_HANDLER_KEY,
  events: [EVENTO_DE_LEAD_CRIADO],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const summary = await aplicaGatilhoDeLead(
        {
          db: createSupabaseGatilhoLeadDb(admin),
          gateDb: createSupabaseFollowupGateDb(admin),
          clock: () => new Date(),
        },
        row,
      );
      return {
        consumer_key: FOLLOWUP_GATILHO_LEAD_HANDLER_KEY,
        status: summary.matched && summary.enrolled > 0 ? "ok" : "skipped",
        detail:
          `armados=${summary.pointers_armados} enrolled=${summary.enrolled} ` +
          `origem_obsoleta=${summary.skipped_stale_origin ?? 0} ja_vivo=${summary.skipped_existing} gate=${summary.pointers_barrados_pelo_gate} ` +
          `sem_contato=${summary.sem_contato} planilha=${summary.vindos_de_planilha}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FOLLOWUP_GATILHO_LEAD_HANDLER_KEY, status: "error", detail };
    }
  },
};
