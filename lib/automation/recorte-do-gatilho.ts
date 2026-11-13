/**
 * O RECORTE por regra de um gatilho — um lugar por gatilho, e o motor pergunta
 * uma vez (#4075).
 *
 * ─── O que existia, e o que era o problema ────────────────────────────────
 *
 * `lead.created` já sabia recortar: a regra guarda `trigger_config.
 * webhook_source_id` e só roda quando o negócio nasceu DAQUELA fonte (#2553).
 * Esse recorte morava dentro do filtro do motor, como um `if (row.event_type
 * === "lead.created" && ...)` escrito no meio da seleção.
 *
 * Acrescentar o segundo gatilho recortável do mesmo jeito produziria o segundo
 * `if` paralelo — e o terceiro produziria o terceiro, até o filtro virar uma
 * cadeia de condições de tipos de evento que ninguém consegue ler. Aqui é um
 * REGISTRO: cada gatilho que precisa recortar é UMA entrada, e o motor chama
 * `recorteDoGatilhoCasa` sem saber qual é.
 *
 * Gatilho que não está no registro não recorta nada (devolve `true`) — que é o
 * comportamento de todos os outros: o evento já é o fato, e quem filtra o resto
 * são as condições da regra.
 */
import { comentarioCasa, configDoComentario, GATILHO_COMENTARIO } from "@/lib/automation/gatilho-do-comentario";

/** O contexto que o recorte pode consultar — hidratado pelo motor, uma vez. */
export interface ContextoDoRecorte {
  /** `crm_leads.source_metadata.webhook_source_id` do negócio do evento. */
  webhookSourceId?: unknown;
}

/** `(config da regra, payload do evento, contexto) → a regra vale para este evento?` */
type Recorte = (
  config: Record<string, unknown>,
  payload: Record<string, unknown>,
  contexto: ContextoDoRecorte,
) => boolean;

const RECORTES: Record<string, Recorte> = {
  /**
   * "Novo negócio" limitado a UMA fonte de formulário (#2553). Regra sem a
   * chave segue valendo para todo negócio novo, como antes.
   */
  "lead.created": (config, _payload, contexto) => {
    const fonte = config.webhook_source_id;
    if (typeof fonte !== "string") return true;
    return fonte === contexto.webhookSourceId;
  },

  /**
   * "Comentou a palavra X num post" (#4075). O post e a palavra moram na
   * configuração da regra; o comentário chega no payload do evento.
   *
   * `comentarioCasa` recusa configuração ilegível — e recusar é o lado seguro:
   * um `trigger_config` torto não pode virar "vale para todo comentário".
   */
  [GATILHO_COMENTARIO]: (config, payload) =>
    comentarioCasa(configDoComentario(config), {
      post_id: payload.post_id,
      text: payload.text,
    }),
};

/**
 * A regra vale para este evento?
 *
 * Um `Record` e não uma cadeia de `if`: quem acrescenta um gatilho recortável
 * acrescenta UMA linha, e nenhum gatilho existente muda de comportamento.
 */
export function recorteDoGatilhoCasa(
  eventType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
  contexto: ContextoDoRecorte,
): boolean {
  const recorte = RECORTES[eventType];
  if (!recorte) return true;
  return recorte(triggerConfig ?? {}, payload ?? {}, contexto);
}
