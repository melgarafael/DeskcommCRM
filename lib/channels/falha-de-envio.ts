/**
 * A FALHA DE ENVIO PASSA ADIANTE SE É PERMANENTE OU TRANSITÓRIA.
 *
 * Medido ao vivo em 15/11/2026: o provedor de uma rede social recusou com HTTP
 * 400 a resposta em áudio do agente. O motor trata todo `failed` como "tente o
 * turno de novo", a fila re-rodou o turno inteiro várias vezes, e o
 * `send_ledger` rotaciona a chave a cada `failed` — então cada nova tentativa
 * mandou o MESMO conteúdo de novo e deixou mais um balão vermelho na conversa.
 * Uma recusa 4xx é a resposta do provedor para AQUELE conteúdo: repetir só
 * repete a recusa.
 *
 * O desfecho viaja por uma linha só, sem schema novo:
 *
 *   adapter (lança `FalhaDeEnvioDoCanal` ou um erro com `upstreamStatus`)
 *     → handler de mensagens (grava `metadata.falha_de_envio` na linha `failed`)
 *     → `send_ledger` (o desfecho `failed` leva `permanente`; a nova tentativa
 *        do MESMO corpo não sai de novo)
 *     → turno (falha permanente encerra o turno sem retry, com aviso na Central).
 *
 * O padrão é `transitoria`: erro que este módulo não reconhece segue o
 * comportamento de antes (o turno é re-tentado). Só o adapter que SABE que a
 * recusa é definitiva diz isso — classificar por adivinhação trocaria um laço
 * de balões por uma resposta perdida que a rede devolveria em um minuto.
 *
 * Prior art: `./erro-da-plataforma.ts` (de quem é a falha de uma campanha) —
 * mesma doutrina: mandar duas vezes é pior que não mandar.
 *
 * Puro e sem I/O.
 */

export type NaturezaDaFalha = "permanente" | "transitoria";

/**
 * A falha que o ADAPTER já classificou. A mensagem continua sendo o texto que
 * o handler grava em `error_message` — quem lê esse texto (frases da tela,
 * `ehLimiteDeVelocidade`, `codigoDaPlataforma`) não muda.
 */
export class FalhaDeEnvioDoCanal extends Error {
  constructor(
    message: string,
    public readonly natureza: NaturezaDaFalha,
    public readonly statusHttp?: number,
    public readonly codigo?: string,
  ) {
    super(message);
    this.name = "FalhaDeEnvioDoCanal";
  }
}

/**
 * O status HTTP de uma recusa do provedor, lido como natureza.
 *
 *   - 408 (tempo esgotado), 425 (cedo demais) e 429 (devagar): a mesma
 *     mensagem sai daqui a pouco — transitória;
 *   - os outros 4xx: o provedor recusou ESTE pedido (formato, mídia,
 *     credencial, conversa) — permanente;
 *   - 5xx: o provedor caiu — transitória;
 *   - abaixo de 400: só chega aqui quando o provedor respondeu "sucesso" no
 *     status e recusou no corpo — ele leu o pedido e disse não: permanente.
 */
export function naturezaDoStatusHttp(status: number): NaturezaDaFalha {
  if (status === 408 || status === 425 || status === 429) return "transitoria";
  if (status >= 500) return "transitoria";
  return "permanente";
}

/** O que o adapter lançou, lido como natureza. Desconhecido = transitória (o de sempre). */
export function naturezaDaFalhaDeEnvio(err: unknown): {
  natureza: NaturezaDaFalha;
  statusHttp?: number;
} {
  if (err instanceof FalhaDeEnvioDoCanal) {
    return err.statusHttp === undefined
      ? { natureza: err.natureza }
      : { natureza: err.natureza, statusHttp: err.statusHttp };
  }
  // O cliente HTTP das redes sociais carrega o status do provedor em
  // `upstreamStatus` (`./social/client.ts`). Lido pela forma, não pela classe:
  // o mesmo campo vale para qualquer cliente que o adote.
  if (err && typeof err === "object" && "upstreamStatus" in err) {
    const status = (err as { upstreamStatus?: unknown }).upstreamStatus;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100) {
      return { natureza: naturezaDoStatusHttp(status), statusHttp: status };
    }
  }
  return { natureza: "transitoria" };
}

/**
 * A chave em `messages.metadata` onde o handler grava a natureza. Um lugar só
 * escreve (o handler) e um lugar só lê (`falhaPermanenteNaMensagem`) — ninguém
 * percorre o caminho do jsonb na mão.
 */
export const CHAVE_DA_FALHA_DE_ENVIO = "falha_de_envio";

export interface RegistroDaFalhaDeEnvio {
  natureza: NaturezaDaFalha;
  status_http?: number;
}

export function registroDaFalhaDeEnvio(err: unknown): RegistroDaFalhaDeEnvio {
  const { natureza, statusHttp } = naturezaDaFalhaDeEnvio(err);
  return statusHttp === undefined ? { natureza } : { natureza, status_http: statusHttp };
}

/** A linha `failed` registrou recusa definitiva? Ausente/ilegível = não (o de sempre). */
export function falhaPermanenteNaMensagem(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const registro = (metadata as Record<string, unknown>)[CHAVE_DA_FALHA_DE_ENVIO];
  if (!registro || typeof registro !== "object") return false;
  return (registro as { natureza?: unknown }).natureza === "permanente";
}

/** Código classificado pelo canal; sem classificação, preserva o fallback do handler. */
export function codigoDaFalhaDeEnvio(err: unknown, fallback: string): string {
  return err instanceof FalhaDeEnvioDoCanal && err.codigo ? err.codigo : fallback;
}
