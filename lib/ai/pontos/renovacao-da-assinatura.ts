/**
 * A RENOVAÇÃO DO LOGIN DO CODEX — antes de vencer, uma vez só, nunca em rota.
 *
 * Acompanha `./pkce-da-assinatura.ts` (o login) e `./reserva-da-assinatura.ts`
 * (o que fazer quando a assinatura falha). Três decisões, e só três:
 *
 *  1. **Proativa.** Renovar DEPOIS de o access_token vencer é deixar uma
 *     chamada de cliente cair para a reserva sem motivo. A janela é de
 *     aproximadamente 8 dias ANTES do fim — folga para a instalação ficar dias
 *     sem ninguém mexer nela, e o refresh_token do Codex tem validade longa.
 *  2. **Uma tentativa só.** `refresh_token_revoked` não é erro transitório:
 *     repetir é mandar o mesmo refresh_token sabidamente recusado. O estado
 *     fica em processo (o `Set` abaixo), e quando o escopo do token estiver
 *     decidido pelo mantenedor ele passa a ser gravado junto com ele.
 *  3. **Uma rotação por chave.** Duas chamadas ao mesmo tempo que os dois
 *     percebem o token vencido fariam DOIS POSTs de refresh — e o segundo
 *     chega com um refresh_token que o primeiro acabou de trocar, o que
 *     derruba a sessão inteira. A trava por chave serializa os dois no MESMO
 *     resultado.
 *
 * O que este módulo NÃO faz: não fala com rede (o `renovar` vem de fora, já
 * injetável) e não altera a semântica da queda — o motivo revogado vira decisão
 * de queda pelas funções EXISTENTES de `./reserva-da-assinatura.ts`.
 */
import { ErroDeToken } from "./pkce-da-assinatura";
import type { MotivoDeFalhaDeToken, TokensDoCodex } from "./pkce-da-assinatura";
import { PROVEDOR_POR_ASSINATURA, decidirQuedaDoProvedor } from "./reserva-da-assinatura";
import type { DecisaoDaQueda } from "./reserva-da-assinatura";

/** A folga: renovar quando faltam 8 dias ou menos para o token vencer. */
export const JANELA_DE_RENOVACAO_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Está na hora de renovar? `null` (provedor não disse quando vence) nunca decide
 * por conta própria: renovar sem precisar troca um refresh_token bom por nada.
 */
export function renovacaoProxima(expiraEm: number | null, agora: number = Date.now()): boolean {
  if (expiraEm === null) return false;
  return expiraEm - agora <= JANELA_DE_RENOVACAO_MS;
}

/** Renova só se a janela abriu. Devolve `true` quando renovou. */
export async function renovarSeProxima(entrada: {
  expiraEm: number | null;
  renovar: () => Promise<TokensDoCodex>;
  agora?: number;
}): Promise<boolean> {
  if (!renovacaoProxima(entrada.expiraEm, entrada.agora)) return false;
  await entrada.renovar();
  return true;
}

/**
 * A TRAVA POR CHAVE: uma rotação em voo, as demais esperando o MESMO resultado.
 *
 * O mapa é por processo, e é o bastante — o refresh acontece no servidor, onde
 * a ordem das requisições é esta. A entrada é apagada ao terminar para que a
 * próxima janela de renovação comece limpa.
 */
const rotacoesEmCurso = new Map<string, Promise<unknown>>();

export async function comTravaDeRotacao<T>(chave: string, rotacao: () => Promise<T>): Promise<T> {
  const emCurso = rotacoesEmCurso.get(chave);
  if (emCurso !== undefined) return emCurso as T;
  const promessa: Promise<T> = rotacao().finally(() => {
    if (rotacoesEmCurso.get(chave) === promessa) rotacoesEmCurso.delete(chave);
  });
  rotacoesEmCurso.set(chave, promessa);
  return promessa;
}

/**
 * As chaves cujo refresh_token o provedor já revogou. Para essas, tentar de novo
 * é mandar de propósito um token que não vale mais.
 */
const chavesRevogadas = new Set<string>();

/** Só para teste: esquece o estado de revogação. */
export function esquecerEstadosDeRefresh(): void {
  chavesRevogadas.clear();
  rotacoesEmCurso.clear();
}

export type ResultadoDoRefresh =
  { ok: true; tokens: TokensDoCodex } | { ok: false; motivo: MotivoDeFalhaDeToken };

/**
 * Renova, com a trava e a memória de revogação.
 *
 *  - chave revogada → devolve `refresh_token_revoked` SEM chamar `renovar`;
 *  - concorrência → todas as chamadas esperam a primeira e recebem o MESMO
 *    resultado (um POST só);
 *  - `ErroDeToken` de rede ou recusa → `ok:false`, sem marcar revogada: o
 *    próximo passo pode tentar de novo.
 */
export async function renovarComTrava(entrada: {
  chave: string;
  renovar: () => Promise<TokensDoCodex>;
}): Promise<ResultadoDoRefresh> {
  if (chavesRevogadas.has(entrada.chave)) {
    return { ok: false, motivo: "refresh_token_revoked" };
  }
  return comTravaDeRotacao(entrada.chave, async (): Promise<ResultadoDoRefresh> => {
    try {
      return { ok: true, tokens: await entrada.renovar() };
    } catch (erro) {
      const motivo: MotivoDeFalhaDeToken = erro instanceof ErroDeToken ? erro.motivo : "recusado";
      if (motivo === "refresh_token_revoked") chavesRevogadas.add(entrada.chave);
      return { ok: false, motivo };
    }
  });
}

/**
 * O retry ÚNICO em 401: renova uma vez e tenta de novo uma vez.
 *
 * Se a segunda também vier 401, ela é devolvida como está — quem classifica a
 * falha (`decidirQuedaDoProvedor`) manda a chamada para a reserva. Um loop de
 * retentativas aqui gastaria a cota da assinatura para repetir o mesmo erro.
 */
export async function chamarComRetryUnicoEm401<T>(entrada: {
  tentar: () => Promise<{ status: number; corpo: T }>;
  renovarApos401: () => Promise<unknown>;
}): Promise<{ status: number; corpo: T; tentativas: number }> {
  const primeira = await entrada.tentar();
  if (primeira.status !== 401) return { ...primeira, tentativas: 1 };
  await entrada.renovarApos401();
  const segunda = await entrada.tentar();
  return { ...segunda, tentativas: 2 };
}

/**
 * `refresh_token_revoked` virando decisão de queda — pelas funções que já
 * existem, sem mudar a semântica delas: o status 401 com o detalhe revogado já
 * classifica como motivo de queda (`classificarFalhaDaAssinatura`), e aí vale a
 * regra de sempre: reserva se houver, humano se não houver.
 */
export function quedaPorTokenRevogado(temChaveDeReserva: boolean): DecisaoDaQueda | null {
  return decidirQuedaDoProvedor({
    provider: PROVEDOR_POR_ASSINATURA,
    status: 401,
    detalhe: "refresh_token_revoked",
    temChaveDeReserva,
  });
}
