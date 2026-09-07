/**
 * Adapter fino que pluga `aplicaGatilhoDeEtapa` (lib/followup/gatilho-etapa.ts)
 * no dispatcher genérico do `event_log` — mesmo padrão de
 * `reactivity.handler.ts`: a lógica fica pura e testável, aqui só há a ligação
 * com o registry e o client de produção.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import {
  EVENTO_DE_ETAPA,
  aplicaGatilhoDeEtapa,
  createSupabaseGatilhoEtapaDb,
} from "@/lib/followup/gatilho-etapa";

export const FOLLOWUP_GATILHO_ETAPA_HANDLER_KEY = "followup-gatilho-etapa.v1";

export const followupGatilhoEtapaHandler: EventHandler = {
  key: FOLLOWUP_GATILHO_ETAPA_HANDLER_KEY,
  events: [EVENTO_DE_ETAPA],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const summary = await aplicaGatilhoDeEtapa(
        {
          db: createSupabaseGatilhoEtapaDb(admin),
          gateDb: createSupabaseFollowupGateDb(admin),
          clock: () => new Date(),
        },
        row,
      );
      return {
        consumer_key: FOLLOWUP_GATILHO_ETAPA_HANDLER_KEY,
        // `ok` DESCARTA o `detail` (lib/event-log/drain.ts): só o de `skipped`
        // sobrevive na linha do event_log. Enquanto o único desfecho mudo era
        // "nenhum fluxo armado" isso custava pouco; com o portão de origem
        // (`origem_obsoleta`) o motivo de o follow-up NÃO nascer virou
        // invisível — e um e2e vermelho passou a não dizer por quê. Casar
        // `matched` com `enrolled > 0` faz o contador chegar à linha.
        status: summary.matched && summary.enrolled > 0 ? "ok" : "skipped",
        // `sem_contato` vai no detail de propósito: é o desfecho em que o
        // gatilho estava armado e mesmo assim ninguém foi enrollado. Sem ele,
        // esse caso seria indistinguível de "nenhum fluxo armado".
        detail:
          `armados=${summary.pointers_armados} enrolled=${summary.enrolled} ` +
          `origem_obsoleta=${summary.skipped_stale_origin ?? 0} ja_vivo=${summary.skipped_existing} gate=${summary.pointers_barrados_pelo_gate} ` +
          `sem_contato=${summary.sem_contato}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FOLLOWUP_GATILHO_ETAPA_HANDLER_KEY, status: "error", detail };
    }
  },
};
