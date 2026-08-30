/**
 * Centralised handler registration for the event_log dispatcher.
 *
 * Imported by the cron drain route (and the workers entry point) so a single
 * call wires every consumer. Keep it lightweight — no DB calls at import time.
 */

import { aiResponseHandler } from "@/workers/ai-response-worker.handler";
import { aiSentimentHandler } from "@/workers/ai-sentiment-worker.handler";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";
import { ragIndexerHandler } from "@/workers/rag-indexer.handler";
import { lgpdExportHandler } from "@/workers/lgpd-export-worker.handler";
import { lgpdRedactHandler } from "@/workers/lgpd-redact-worker.handler";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import { followupReactivityHandler } from "@/lib/followup/reactivity.handler";
import { followupGatilhoEtapaHandler } from "@/lib/followup/gatilho-etapa.handler";
import { followupGatilhoCasoHandler } from "@/lib/followup/gatilho-caso.handler";
import { mediaPersistHandler } from "@/workers/media-persist-worker.handler";
import { mediaDeriveHandler } from "@/workers/media-derive-worker.handler";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import { registerHandler } from "@/lib/event-log/dispatcher";

let _registered = false;

export function ensureHandlersRegistered(): void {
  if (_registered) return;
  // Follow-up de inbound ANTES do LLM: no Hobby o drain da mensagem
  // estourava no worker de IA e o match_reply nunca lia a resposta.
  registerHandler(followupReactivityHandler);
  registerHandler(aiResponseHandler);
  registerHandler(aiSentimentHandler);
  registerHandler(aiHandoffFromSentimentHandler);
  registerHandler(ragIndexerHandler);
  registerHandler(lgpdExportHandler);
  registerHandler(lgpdRedactHandler);
  registerHandler(automationRulesHandler);
  registerHandler(followupGatilhoEtapaHandler);
  registerHandler(followupGatilhoCasoHandler);
  registerHandler(mediaPersistHandler);
  registerHandler(mediaDeriveHandler);
  registerHandler(webPushInboundHandler);
  // Por último: reportar a venda ao anúncio é o consumidor mais externo do
  // fechamento — depende de rede de terceiro e não pode atrasar quem escreve
  // no banco. Falha dele nunca segura os handlers acima.
  registerHandler(conversaoDeVendaHandler);
  _registered = true;
}
