import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O INÍCIO da janela que o sync lê — `agora - 1 dia`, o mesmo de
 * `window_start` na leitura completa (`fn_google_calendar`:
 * `now()-interval '1 day'` até `now()+interval '90 days'`).
 *
 * A fila usa ESTE mesmo início, e de propósito não o fim: o horizonte de 90
 * dias é o que a VOLTA espelha, e cortar a IDA por ele adiaria a criação de um
 * evento marcado para daqui a cinco meses. Compromisso cujo `ends_at` já ficou
 * para trás desse início saiu do espelho que o CRM mantém: empurrá-lo não muda
 * nada que o outro lado (ou a volta) consiga enxergar.
 */
const INICIO_DA_JANELA_MS = 24 * 60 * 60 * 1000;

/**
 * Seleção comum do cron e da prova PostgREST; associação antiga também é relida.
 *
 * ⚠️ O RECORTE DE STATUS E DE DATA MORA NA VIEW (`calendar_service_google_push_queue`,
 * migration 9358, #4448) e é repetido aqui porque filtro do PostgREST é aplicado
 * ANTES do `limit 50`: sem ele, linha morta ocuparia o lote. As duas pontas têm
 * de dizer a mesma coisa — `status` e a janela são os mesmos da view, e
 * `tests/invariants/agenda-google-fila-drena.test.ts` compara o conjunto que sai
 * por aqui com o que sai por SQL direto na view.
 *
 * A view da fila é PRÓPRIA (`calendar_service_google_push_queue`), e não a
 * histórica `calendar_service_google_candidates`: aquela é criada por
 * `create or replace view` numa migration já aplicada, que a cadeia reaplica sobre
 * o baseline — coluna nova lá derruba a migration inteira com `cannot drop columns
 * from view` (o porquê está no cabeçalho da 9358).
 *
 * `completed` e `no_show` NÃO empurram (lib/agenda/laco.ts: o evento lá fora já
 * aconteceu, registrar o desfecho aqui não muda o calendário de ninguém); o
 * `cancelled` fica porque é ele que pede a remoção do evento no Google.
 */
export function googlePushCandidates(db: SupabaseClient, now = new Date()) {
  return db
    .from("calendar_service_google_push_queue")
    .select("id,organization_id,user_id:owner_user_id")
    .or(
      "needs_google_push.eq.true,and(google_event_id.not.is.null,google_conflict.is.null),google_conflict->resolution.not.is.null",
    )
    .in("status", ["pending", "confirmed", "cancelled"])
    .gt("ends_at", new Date(now.getTime() - INICIO_DA_JANELA_MS).toISOString())
    .lte("google_next_attempt_at", now.toISOString())
    .not("owner_user_id", "is", null)
    .order("google_next_attempt_at")
    .limit(50);
}
