import { ApiError } from "@/lib/api/types";

/**
 * A RÉGUA ÚNICA de "esta falha vale outra tentativa?".
 *
 * ─── Por que um módulo só ───────────────────────────────────────────────────
 *
 * A pergunta era respondida em DOIS lugares, com listas diferentes: o cliente
 * HTTP (`lib/api/client.ts`) repetia 429 e 503, e o cliente de queries
 * (`lib/query/client.ts`) repetia 429 e 503 de novo. Duas listas que dizem a
 * mesma coisa divergem na primeira manutenção — e a que ficasse para trás
 * passaria a repetir (ou a desistir de) um estado que a outra já tratava.
 *
 * ─── A separação que importa ────────────────────────────────────────────────
 *
 * TRANSPORTE — tempo esgotado, conexão caída, servidor fora — é transitório:
 * a mesma pergunta, feita de novo, pode voltar com resposta. Vale repetir.
 *
 * CONTRATO — 400, 401, 403, 404 e 422 — é o servidor dizendo "este pedido não
 * serve". Repetir não muda o pedido: multiplica o erro. 401 e 403 entram aqui
 * como CLASSE (não se repetem automaticamente), ainda que a tela tenha
 * tratamento próprio para eles.
 *
 * 429 entra porque é o servidor pedindo ESPERA, não recusando o pedido.
 * 502/503/504 entram porque são a mesma família do 5xx: a requisição não
 * chegou a ser respondida com um resultado.
 */
export const STATUS_QUE_VALE_REPETIR: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Os status em que o SERVIDOR DIZ que nada aconteceu — e que por isso a
 * ESCRITA também pode repetir.
 *
 * A regra é sobre INCERTEZA, não sobre método (é a que `client.test.ts` já
 * prendia em t11/t11b): 429 e 503 são respostas, e resposta não deixa dúvida
 * sobre o efeito. Já 502/504 vêm de um intermediário que não conseguiu falar
 * com o destino — o destino pode ter processado o pedido e só a resposta ter
 * se perdido. Repetir uma escrita ali é a mesma aposta que repetir no timeout,
 * e duplicar mensagem é pior que mostrar o erro.
 */
export const STATUS_QUE_NAO_PROCESSOU: ReadonlySet<number> = new Set([429, 503]);

/**
 * O que a pessoa na tela precisa saber. São estados DISTINGUÍVEIS de propósito:
 * "excedeu o tempo" e "sua sessão expirou" pedem ações diferentes de quem está
 * atendendo, e a frase genérica ("erro inesperado") não ajuda em nenhuma.
 */
export type TipoDeFalha =
  | "tempo_esgotado"
  | "sem_conexao"
  | "servidor"
  | "sessao"
  | "permissao"
  | "pedido_recusado"
  | "desconhecida";

export function statusValeRepetir(status: number): boolean {
  return STATUS_QUE_VALE_REPETIR.has(status);
}

/**
 * A leitura pode repetir 429/502/503/504; a escrita, só onde o servidor diz
 * que nada aconteceu. Ver `STATUS_QUE_NAO_PROCESSOU`.
 */
export function statusValeRepetirEscrita(status: number): boolean {
  return STATUS_QUE_NAO_PROCESSOU.has(status);
}

/**
 * Erro de contrato: o pedido em si está errado, e repeti-lo só repete o erro.
 * Vale para as duas camadas — é esta função que impede a escada de retentativa
 * de alcançar um 400.
 */
export function ehErroDeContrato(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    !statusValeRepetir(err.status)
  );
}

function nomeDoErro(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const nome = (err as { name?: unknown }).name;
  return typeof nome === "string" ? nome : null;
}

/**
 * Falha transitória — a única classe que a escada de retentativa pode tocar.
 *
 * `TimeoutError` é o nome que o cliente HTTP do repo crava no motivo do abort
 * (o mesmo que `AbortSignal.timeout()` sintetiza); `TypeError` é o que o
 * `fetch` lança quando não consegue falar com o servidor.
 */
export function ehFalhaTransitoria(err: unknown): boolean {
  if (err instanceof ApiError) return statusValeRepetir(err.status);
  const nome = nomeDoErro(err);
  return nome === "TimeoutError" || nome === "TypeError";
}

export function tipoDeFalha(err: unknown): TipoDeFalha {
  if (err instanceof ApiError) {
    if (err.status === 401) return "sessao";
    if (err.status === 403) return "permissao";
    if (statusValeRepetir(err.status) || err.status >= 500) return "servidor";
    if (err.status >= 400) return "pedido_recusado";
    return "desconhecida";
  }
  const nome = nomeDoErro(err);
  if (nome === "TimeoutError") return "tempo_esgotado";
  if (nome === "TypeError") return "sem_conexao";
  return "desconhecida";
}
