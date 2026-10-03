/**
 * Adapter that exposes `ai-sentiment-worker` to the event_log dispatcher.
 *
 * Registers on `message.received` alongside `ai-response-worker.v1`. O dreno
 * roda os handlers EM SÉRIE (`lib/event-log/dispatcher.ts`), um evento por vez:
 * a chamada ao modelo daqui atrasa todo consumidor que vem depois no lote.
 */

import { ADIAMENTO_DO_DRENO_EM_REQUEST_MS } from "@/lib/escalacao/aviso-ao-suporte";
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { origemDoDreno } from "@/lib/event-log/origem-do-dreno";
import { processSentiment } from "@/workers/ai-sentiment-worker";

export const AI_SENTIMENT_HANDLER_KEY = "ai-sentiment-worker.v1";

export const aiSentimentHandler: EventHandler = {
  key: AI_SENTIMENT_HANDLER_KEY,
  naOrgParada: "pula",
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    // Dreno DENTRO do webhook de mensagem (`acelerarPipelineDeEventos`): a
    // chamada ao modelo somaria ao tempo de resposta do webhook, que tem timeout
    // e reentrega — e roda ANTES de o despacho do agente ser emitido. `retry`
    // deixa a linha `pending` sem contar tentativa, com os outros handlers já
    // em `consumed_by`.
    //
    // `retry_at` no futuro, e não "agora": todo inbound drena o `event_log` com
    // a mesma consulta (as 50 `pending` mais antigas já vencidas). Com "agora",
    // a linha adiada voltava a cada webhook seguinte — reivindicada, adiada e
    // regravada de novo — e, numa rajada, as adiadas (mais antigas) ocupavam o
    // lote e empurravam para fora os eventos da mensagem que acabou de chegar.
    // O adiamento é o mesmo dos avisos de caso e de proposta: a linha sai do
    // alcance de TODO dreno por esse prazo. Vencido, quem chegar primeiro a
    // pega — o laço do worker (ou o cron) roda o sentimento; um webhook a adia
    // de novo, no máximo uma vez por prazo. Nada aqui garante que o handoff
    // por sentimento saia antes de a janela de rajada do agente fechar.
    if (origemDoDreno() === "request") {
      return {
        consumer_key: AI_SENTIMENT_HANDLER_KEY,
        status: "retry",
        retry_at: new Date(Date.now() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS).toISOString(),
        detail: "adiado: dreno dentro do webhook",
      };
    }
    const result = await processSentiment(row);
    if (!result.skipped) {
      return {
        consumer_key: AI_SENTIMENT_HANDLER_KEY,
        status: "ok",
        detail: String(result.sentiment_score ?? ""),
      };
    }
    return {
      consumer_key: AI_SENTIMENT_HANDLER_KEY,
      status: "skipped",
      detail: result.reason,
    };
  },
};
