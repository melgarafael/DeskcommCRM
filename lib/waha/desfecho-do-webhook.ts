/**
 * O DESFECHO DE UM EVENTO WAHA — o mesmo para a rota e para o reprocessamento.
 *
 * `webhook_events_log` tinha `status` (received/processed/error/dead), `attempts`
 * e índice de fila morta, e nenhum código mudava o status: toda linha nascia e
 * morria `received` (17.420 de 17.420 numa VPS de produção em 24/09/2026). Era
 * evento sem consumidor — o arquivo existia e ninguém sabia quais linhas tinham
 * virado mensagem.
 *
 * Aqui cada evento sai com um desfecho gravado:
 *
 *   - `processed` — a ingestão terminou (inclusive quando decidiu ignorar o
 *     evento, como presença ou grupo);
 *   - `error` com `transitoria:` no começo da mensagem — o banco falhou de um
 *     jeito que outra tentativa resolve (ver `falha-transitoria.ts`). A rota
 *     devolve 503 para o WAHA reentregar, e o cron `webhook-replay` reprocessa
 *     a linha se as reentregas do WAHA também não bastarem;
 *   - `error` sem o prefixo — falha que tentar de novo não conserta. A rota
 *     segue devolvendo 200, como antes, e a linha fica contável.
 *
 * Gravar o desfecho é best-effort: se o banco está fora, o UPDATE também falha,
 * e isso não muda a resposta ao WAHA — é justamente o caso em que a reentrega
 * dele é o que salva a mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { FalhaTransitoriaDeIngestao, PREFIXO_TRANSITORIA } from "@/lib/waha/falha-transitoria";
import type { WahaEnvelope } from "@/lib/waha/envelope";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

type Admin = Parameters<typeof dispatchWahaEvent>[0];
type Sessao = Parameters<typeof dispatchWahaEvent>[1];

export type DesfechoDoEvento = "processado" | "tentar_de_novo" | "desistiu";

/** Segundos sugeridos ao WAHA no `Retry-After` do 503. */
export const REENTREGA_EM_SEGUNDOS = 5;

async function gravarDesfecho(
  admin: Admin,
  logId: string | null,
  campos: { status: "processed" | "error"; error_message: string | null },
): Promise<void> {
  if (!logId) return;
  try {
    const { error } = await (admin as unknown as SupabaseClient)
      .from("webhook_events_log")
      .update(campos)
      .eq("id", logId);
    if (error) {
      logger.warn("[waha.webhook] desfecho do evento não gravado", { log_id: logId, detail: error.message });
    }
  } catch (err) {
    logger.warn("[waha.webhook] desfecho do evento não gravado", {
      log_id: logId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function processarEventoWaha(
  admin: Admin,
  session: Sessao,
  envelope: WahaEnvelope,
  requestId: string,
  logId: string | null,
): Promise<DesfechoDoEvento> {
  try {
    await dispatchWahaEvent(admin, session, envelope, requestId);
  } catch (err) {
    if (err instanceof FalhaTransitoriaDeIngestao) {
      logger.warn("[waha.webhook] banco indisponível na ingestão — pedindo nova tentativa", {
        request_id: requestId,
        log_id: logId,
        etapa: err.etapa,
        codigo: err.codigo,
      });
      await gravarDesfecho(admin, logId, {
        status: "error",
        error_message: `${PREFIXO_TRANSITORIA} ${err.message}`.slice(0, 500),
      });
      return "tentar_de_novo";
    }
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[waha.webhook] handler failed", { request_id: requestId, log_id: logId, detail: detalhe });
    await gravarDesfecho(admin, logId, { status: "error", error_message: `handler: ${detalhe}`.slice(0, 500) });
    return "desistiu";
  }
  await gravarDesfecho(admin, logId, { status: "processed", error_message: null });
  return "processado";
}
