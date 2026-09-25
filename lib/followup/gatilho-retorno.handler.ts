/**
 * Adapter fino que pluga `aplicaGatilhoDeRetorno` no dispatcher do `event_log`.
 *
 * Registrado DEPOIS da reatividade e ANTES do LLM: o match_reply dos fluxos
 * já vivos lê a mensagem primeiro; este enrolla o retorno; o agente só fala
 * se `ceder-turno-ao-retorno` deixar.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { avancarFollowupsAtivosDoContato } from "@/lib/followup/aplicar-inbound";
import {
  EVENTO_DE_RETORNO,
  aplicaGatilhoDeRetorno,
  createSupabaseGatilhoRetornoDb,
} from "@/lib/followup/gatilho-retorno";

export const FOLLOWUP_GATILHO_RETORNO_HANDLER_KEY = "followup-gatilho-retorno.v1";

export const followupGatilhoRetornoHandler: EventHandler = {
  key: FOLLOWUP_GATILHO_RETORNO_HANDLER_KEY,
  events: [EVENTO_DE_RETORNO],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const summary = await aplicaGatilhoDeRetorno(
        {
          db: createSupabaseGatilhoRetornoDb(admin),
          gateDb: createSupabaseFollowupGateDb(admin),
          clock: () => new Date(),
        },
        row,
      );
      if (summary.enrolled > 0 && summary.contact_id) {
        await avancarFollowupsAtivosDoContato(admin, row.organization_id, summary.contact_id);
      }
      return {
        consumer_key: FOLLOWUP_GATILHO_RETORNO_HANDLER_KEY,
        status: summary.matched && summary.enrolled > 0 ? "ok" : "skipped",
        detail:
          `armados=${summary.pointers_armados} enrolled=${summary.enrolled} ` +
          `origem_obsoleta=${summary.skipped_stale_origin ?? 0} ja_vivo=${summary.skipped_existing} ` +
          `gate=${summary.pointers_barrados_pelo_gate} gap=${summary.skipped_gap} ` +
          `humano=${summary.skipped_humano} grupo=${summary.skipped_grupo} bloqueado=${summary.skipped_bloqueado}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FOLLOWUP_GATILHO_RETORNO_HANDLER_KEY, status: "error", detail };
    }
  },
};
