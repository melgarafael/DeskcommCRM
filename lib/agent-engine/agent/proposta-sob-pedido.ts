/**
 * O pedido humano usa a mesma recuperação limitada do texto solto (#3281).
 * Só o silêncio inicial sem oferta, veto ou falha ganha essa instrução; a
 * correção canônica continua cuidando do texto solto e do turno automático.
 */
import type { FinishReason } from 'ai';

export const INSTRUCAO_DO_PEDIDO_HUMANO =
  'Uma pessoa da equipe clicou em "Sugerir resposta" e pediu um texto para esta conversa. ' +
  'O turno automático poderia ficar em silêncio, mas agora há um pedido humano de uma proposta. ' +
  'Chame send_message uma vez, no idioma da conversa, com somente a mensagem destinada ao cliente. ' +
  'As regras de conteúdo e a cadeia de envio continuam valendo: nada chega ao cliente sem a ' +
  'aprovação de quem pediu.';

/** Sinais do primeiro turno, antes de ocupar a única recuperação disponível. */
export interface SinaisDoPedidoHumano {
  readonly candidatos: number;
  readonly propostas: number;
  readonly impedimentos: readonly string[];
  readonly tentativasDeEnvio: number;
  readonly textoEscrito: string;
  readonly inboundsSemResposta: number;
  readonly finishReason: FinishReason | undefined;
  readonly saidaTruncada: boolean;
  readonly tetoDePassosAtingido: boolean;
}

/** Só stop confirma silêncio normal; filtro/erro não autoriza pedir texto de novo. */
export function previaContinuaAtePropor(p: SinaisDoPedidoHumano): boolean {
  return (
    p.finishReason === 'stop' &&
    p.candidatos === 0 &&
    p.propostas === 0 &&
    p.impedimentos.length === 0 &&
    p.tentativasDeEnvio === 0 &&
    p.textoEscrito.trim() === '' &&
    p.inboundsSemResposta > 0 &&
    !p.saidaTruncada &&
    !p.tetoDePassosAtingido
  );
}
