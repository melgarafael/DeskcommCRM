/**
 * COMANDOS DE CONTROLE ENVIADOS PELO CELULAR DO OPERADOR.
 *
 * ## Por que existe
 *
 * O dono da operação responde o cliente direto no WhatsApp do celular (o mesmo
 * número vinculado ao bot). Ele precisa de um interruptor: `#off` desliga o
 * automático NESTA conversa e `#on` devolve o atendimento à IA. Sem isto, a
 * única forma de ligar/desligar era pela tela do CRM.
 *
 * ## O que é, e o que NÃO é, um comando
 *
 * Só a mensagem INTEIRA conta. `#off` é comando; "vou dar um #off agora" não é —
 * e isso importa, porque o operador digita no chat do cliente e uma mensagem de
 * venda que por acaso contenha o texto não pode calar a IA.
 *
 * A comparação é feita sobre o corpo normalizado (trim + minúsculas). O produto
 * aceita apenas os literais `#on` e `#off` (decisão do dono em 2026-09-24): sem
 * barra, sem sinônimos, sem variação de caixa além do normalizado.
 *
 * ## Nunca reconhece mensagem do CLIENTE
 *
 * Este parser só é chamado no caminho de SAÍDA feita fora do CRM (`fromMe`) —
 * ver `handleOutboundFromUserPhone`. Mensagem de cliente é `inbound` e nunca
 * chega aqui.
 */

export type ComandoDeCanal = "on" | "off";

/** Os dois literais aceitos, já normalizados. */
const LIGAR = "#on";
const DESLIGAR = "#off";

/**
 * Lê o comando de controle do corpo de uma mensagem. Devolve `"on"`, `"off"` ou
 * `null` quando o corpo não é um comando. Puro: não toca banco e não depende de
 * relógio.
 */
export function lerComandoDeControle(body: string | null | undefined): ComandoDeCanal | null {
  if (typeof body !== "string") return null;
  const normalizado = body.trim().toLowerCase();
  if (normalizado === LIGAR) return "on";
  if (normalizado === DESLIGAR) return "off";
  return null;
}
