import { followupGatilhoPresencaHandler } from "@/lib/followup/gatilho-presenca.handler";
import { followupGatilhoRetornoHandler } from "@/lib/followup/gatilho-retorno.handler";
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
import { campanhaRespostaHandler } from "@/lib/campanhas/resposta.handler";
import { followupGatilhoEtapaHandler } from "@/lib/followup/gatilho-etapa.handler";
import { followupGatilhoLeadHandler } from "@/lib/followup/gatilho-lead.handler";
import { followupGatilhoCasoHandler } from "@/lib/followup/gatilho-caso.handler";
import { mediaPersistHandler } from "@/workers/media-persist-worker.handler";
import { mediaDeriveHandler } from "@/workers/media-derive-worker.handler";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import { avisoDeCasoAoSuporteHandler } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { registerHandler } from "@/lib/event-log/dispatcher";

let _registered = false;

export function ensureHandlersRegistered(): void {
  if (_registered) return;
  // Follow-up de inbound ANTES do LLM: no Hobby o drain da mensagem
  // estourava no worker de IA e o match_reply nunca lia a resposta.
  registerHandler(followupReactivityHandler);
  // Atribuição de resposta da campanha: logo depois da reatividade e ANTES do
  // LLM, pelo mesmo motivo dela — é escrita curta no banco, sem rede de
  // terceiro, e não pode ficar atrás de um consumidor que pode estourar.
  registerHandler(campanhaRespostaHandler);
  // Mesmo critério: o gatilho do cliente que volta é escrita curta no banco e
  // precisa rodar antes do LLM. Depois da reatividade, para o match_reply dos
  // fluxos já vivos ler a mensagem primeiro.
  registerHandler(followupGatilhoRetornoHandler);
  registerHandler(aiResponseHandler);
  registerHandler(aiSentimentHandler);
  registerHandler(aiHandoffFromSentimentHandler);
  registerHandler(ragIndexerHandler);
  registerHandler(lgpdExportHandler);
  registerHandler(lgpdRedactHandler);
  registerHandler(automationRulesHandler);
  registerHandler(followupGatilhoEtapaHandler);
  registerHandler(followupGatilhoLeadHandler);
  registerHandler(followupGatilhoCasoHandler);
  registerHandler(followupGatilhoPresencaHandler);
  registerHandler(mediaPersistHandler);
  registerHandler(mediaDeriveHandler);
  registerHandler(webPushInboundHandler);
  // Penúltimo, pelo MESMO critério do último: o aviso ao suporte sai por rede de
  // terceiro (o transporte de WhatsApp) e nunca pode atrasar quem escreve no
  // banco — inclusive o `followupGatilhoCasoHandler`, que consome o MESMO evento
  // e cuja falha custa um follow-up perdido. Ele também é o único handler que
  // adia a si mesmo quando o dreno está rodando dentro de uma requisição.
  registerHandler(avisoDeCasoAoSuporteHandler);
  // Por último: reportar a venda ao anúncio é o consumidor mais externo do
  // fechamento — depende de rede de terceiro e não pode atrasar quem escreve
  // no banco. Falha dele nunca segura os handlers acima.
  registerHandler(conversaoDeVendaHandler);
  _registered = true;
}
