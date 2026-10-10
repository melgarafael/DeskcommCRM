/**
 * Adapter that exposes `ai-sentiment-worker` to the event_log dispatcher.
 *
 * Registers on `message.received` alongside `ai-response-worker.v1` — both
 * consumers fire in parallel for every inbound message; sentiment never blocks
 * the bot path.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { canalDoEventoDesativado } from "@/lib/channels/desativado";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSentiment } from "@/workers/ai-sentiment-worker";

export const AI_SENTIMENT_HANDLER_KEY = "ai-sentiment-worker.v1";

export const aiSentimentHandler: EventHandler = {
  key: AI_SENTIMENT_HANDLER_KEY,
  naOrgParada: "pula",
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    // Canal DESATIVADO (#2329 → #2433 → #2436): a sexta e última reação a uma
    // mensagem de canal que o operador desligou. O handoff que o sentimento
    // baixo dispararia já era barrado pela elegibilidade, mas o caminho de
    // CIMA dele era pago: com agente no ar, cada mensagem de canal pausado
    // comprava a chamada de LLM do classificador e gravava `sentiment_score`
    // numa conversa que a inbox nem mostra (lei do #2318 nos dois sentidos).
    // Mesma régua dos outros cinco consumidores, uma ida por evento no
    // `channel_session_id` que o `fn_emit_message_event` já escreve no payload.
    if (await canalDoEventoDesativado(createAdminClient(), row.organization_id, row.payload)) {
      return {
        consumer_key: AI_SENTIMENT_HANDLER_KEY,
        status: "skipped",
        detail: "canal_desativado",
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
