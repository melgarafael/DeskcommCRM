/**
 * Adapter fino que pluga `aplicaSaidaDaEtapa` (lib/followup/saida-da-etapa.ts)
 * no dispatcher genérico do `event_log` — mesmo padrão de
 * `gatilho-etapa.handler.ts` e `reactivity.handler.ts`: a lógica fica pura e
 * testável, aqui só há a ligação com o registry e o client de produção.
 *
 * Consome o MESMO `lead.stage_changed` que o gatilho de etapa, e é de propósito:
 * o dispatcher entrega a linha a TODOS os consumidores registrados e registra
 * cada um em `consumed_by[]`. Um evento só, duas metades do mesmo fato — entrou
 * na etapa (arma) e saiu da etapa (desarma).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENTO_DE_ETAPA } from "@/lib/followup/gatilho-etapa";
import { aplicaSaidaDaEtapa, createSupabaseSaidaDaEtapaDb } from "@/lib/followup/saida-da-etapa";

export const FOLLOWUP_SAIDA_DA_ETAPA_HANDLER_KEY = "followup-saida-da-etapa.v1";

export const followupSaidaDaEtapaHandler: EventHandler = {
  key: FOLLOWUP_SAIDA_DA_ETAPA_HANDLER_KEY,
  // "roda": é escrita interna no próprio banco — desagendar não gasta nem fala.
  // Uma organização parada que ficasse com toques armados os dispararia na
  // reativação, fora de contexto e em rajada; cancelar é o lado seguro.
  naOrgParada: "roda",
  events: [EVENTO_DE_ETAPA],
  async handle(row): Promise<HandlerResult> {
    try {
      const summary = await aplicaSaidaDaEtapa(
        { db: createSupabaseSaidaDaEtapaDb(createAdminClient()), clock: () => new Date() },
        row,
      );
      return {
        consumer_key: FOLLOWUP_SAIDA_DA_ETAPA_HANDLER_KEY,
        // `ok` descarta o `detail` (lib/event-log/drain.ts); só o de `skipped`
        // sobrevive na linha do event_log. `matched` é "o evento descreve uma
        // saída"; sem cancelamento ele vira `skipped` e o motivo fica visível.
        status: summary.canceladas > 0 ? "ok" : "skipped",
        detail:
          `armados=${summary.pointers_armados} inscricoes=${summary.inscricoes_encontradas} ` +
          `canceladas=${summary.canceladas} ja_encerradas=${summary.ja_encerradas} ` +
          `sem_contato=${summary.sem_contato} proprio_ator=${summary.proprio_ator}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FOLLOWUP_SAIDA_DA_ETAPA_HANDLER_KEY, status: "error", detail };
    }
  },
};
