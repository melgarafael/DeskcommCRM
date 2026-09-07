/**
 * Adapter fino que pluga `aplicaGatilhoDeCaso` (lib/followup/gatilho-caso.ts) no
 * dispatcher genérico do `event_log` — mesmo padrão de
 * `gatilho-etapa.handler.ts` e `reactivity.handler.ts`: a lógica fica pura e
 * testável, aqui só há a ligação com o registry e o client de produção.
 *
 * ⚠️ UM HANDLER PARA OS DOIS EVENTOS, e não dois. Abertura e fechamento são o
 * mesmo laço: quem cria precisa saber cancelar, e separar em dois consumidores
 * duplicaria a leitura dos pointers e abriria a porta para o dia em que só um
 * dos dois é registrado — o pior desfecho possível aqui, porque seria o que
 * cobra sem nunca parar de cobrar.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseFollowupGateDb } from "@/lib/followup/agent-followup-gate";
import {
  EVENTO_CASO_ABERTO,
  EVENTO_CASO_FECHADO,
  aplicaGatilhoDeCaso,
  createSupabaseGatilhoCasoDb,
} from "@/lib/followup/gatilho-caso";

export const FOLLOWUP_GATILHO_CASO_HANDLER_KEY = "followup-gatilho-caso.v1";

export const followupGatilhoCasoHandler: EventHandler = {
  key: FOLLOWUP_GATILHO_CASO_HANDLER_KEY,
  events: [EVENTO_CASO_ABERTO, EVENTO_CASO_FECHADO],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const summary = await aplicaGatilhoDeCaso(
        {
          db: createSupabaseGatilhoCasoDb(admin),
          gateDb: createSupabaseFollowupGateDb(admin),
          clock: () => new Date(),
        },
        row,
      );
      return {
        consumer_key: FOLLOWUP_GATILHO_CASO_HANDLER_KEY,
        status: summary.matched ? "ok" : "skipped",
        // Cada contador aqui existe porque, sem ele, um desfecho vira
        // indistinguível de outro. `vencidos` e `sem_contato` são os dois casos
        // em que o gatilho ESTAVA armado e mesmo assim ninguém foi enrollado —
        // ler `enrolled=0` sozinho sugeriria "nenhum fluxo armado", que é uma
        // conclusão errada e manda o operador procurar no lugar errado.
        detail:
          `armados=${summary.pointers_armados} enrolled=${summary.enrolled} ` +
          `origem_obsoleta=${summary.skipped_stale_origin ?? 0} ja_vivo=${summary.skipped_existing} gate=${summary.pointers_barrados_pelo_gate} ` +
          `sem_contato=${summary.sem_contato} cancelados=${summary.cancelados} ` +
          `vencidos=${summary.vencidos}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FOLLOWUP_GATILHO_CASO_HANDLER_KEY, status: "error", detail };
    }
  },
};
