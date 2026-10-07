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
 *  2. **Uma tentativa por janela.** `refresh_token_revoked` não é erro
 *     transitório: repetir é mandar o mesmo refresh_token sabidamente
 *     recusado. Quem decide isso agora é a TRAVA DE BANCO de
 *     `./../credenciais/login-codex.ts` (`renovarComTravaDeBanco`): uma
 *     recusa vira `falha`, o token em uso segue no ar e a chamada cai na
 *     reserva pela política que já existe.
 *  3. **Uma rotação por linha, em QUALQUER processo.** Duas chamadas ao mesmo
 *     tempo fariam DOIS POSTs de refresh — e o segundo chega com um
 *     refresh_token que o primeiro acabou de trocar, o que derruba a sessão
 *     inteira. A trava por chave em MEMÓRIA do processo (um Mapa de rotações em curso) foi APAGADA
 *     nesta fatia: `app`, `worker` e `scheduler` são contêineres separados e
 *     um `Map` de processo não os atravessa. A única trava agora é o UPDATE
 *     CONDICIONAL em `ai_provider_credentials.updated_at`, que vale em todos.
 *
 * O que este módulo NÃO faz: não fala com rede (o `renovar` vem de fora, já
 * injetável), não guarda estado de processo (nada aqui é mais uma trava) e não
 * altera a semântica da queda — o motivo revogado vira decisão de queda pelas
 * funções EXISTENTES de `./reserva-da-assinatura.ts`.
 */
import { PROVEDOR_POR_ASSINATURA, decidirQuedaDoProvedor } from "./reserva-da-assinatura";
import type { DecisaoDaQueda } from "./reserva-da-assinatura";
import type { TokensDoCodex } from "./pkce-da-assinatura";

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
