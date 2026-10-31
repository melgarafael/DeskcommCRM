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

/**
 * A ROTAÇÃO É UMA POR JANELA — E A JANELA É DO TOKEN NOVO (#3371, fatia 5).
 *
 * `renovacaoProxima` responde "este token vence nos próximos 8 dias?", e o
 * access_token da assinatura vive BEM menos que isso. Consequência medida em
 * produção: logo depois de rotacionar, o token novo — recém-gravado — já estava
 * "próximo de vencer" pela régua antiga, e TODO turno rotacionava de novo. Foram
 * ~500 POSTs de refresh em ~26 h, dois deles com 35 s de intervalo, até a OpenAI
 * passar a recusar todos.
 *
 * O marco gravado na rotação é o fim da janela daquele par: a última fatia da
 * vida do token (`FRACAO_DA_VIDA_PARA_RENOVAR`), com piso de um minuto. Vida de
 * 1 h → rotaciona nos últimos 6 min; vida de 30 dias → nos últimos 3 dias. A
 * trava de 30 s do banco continua onde está: ela impede dois POSTs SIMULTÂNEOS,
 * e o que muda aqui é a CONDIÇÃO DE NECESSIDADE, que passa a olhar o token novo.
 */
export const FRACAO_DA_VIDA_PARA_RENOVAR = 0.1;

/**
 * Quando este par pode ser rotacionado de novo. `null` quando o provedor não
 * disse quando vence — e aí quem decide é `renovacaoProxima`, como antes.
 */
export function proximaRenovacaoEm(
  expiraEm: number | null,
  agora: number = Date.now(),
): number | null {
  if (expiraEm === null) return null;
  const vida = expiraEm - agora;
  // Já vencido (ou vencendo agora): não há fatia final a esperar.
  if (vida <= 0) return agora;
  return Math.trunc(expiraEm - Math.max(vida * FRACAO_DA_VIDA_PARA_RENOVAR, 60_000));
}

/**
 * Está na hora de rotacionar ESTE par? Duas condições, e as duas precisam valer:
 * o token está dentro da janela de renovação E o marco da rotação anterior já
 * passou. Um par sem marco (gravado antes desta fatia) responde pela régua
 * antiga uma única vez — a rotação seguinte já grava o marco.
 */
export function precisaRenovar(
  tokens: { expires_at: number | null; proxima_renovacao_em?: number | null },
  agora: number = Date.now(),
): boolean {
  if (!renovacaoProxima(tokens.expires_at, agora)) return false;
  const janela = tokens.proxima_renovacao_em;
  if (typeof janela === "number") return agora >= janela;
  return true;
}

/**
 * POR QUE a renovação foi recusada — o vocabulário que a credencial passa a
 * guardar (#3371, fatia 3).
 *
 * A recusa era MUDA: `catch { return { ok: false, motivo: "falha" } }` devolvia
 * o mesmo `falha` para refresh revogado, para `invalid_grant`, para DNS fora do
 * ar e para timeout. Em produção (cliente Obralivre) a renovação tentou ~500
 * vezes em ~26 h e NENHUM registro dizia o motivo — quem abriu o chamado sabia
 * que o token estava vencido e nada mais.
 *
 * O detalhe é um RÓTULO, nunca o texto do provedor: a mensagem de erro de uma
 * chamada de token pode carregar o `refresh_token` recusado, e este valor é
 * gravado em `ai_provider_credentials.validation_error`, que a tela mostra.
 */
export type MotivoDaRecusaDeRenovacao =
  | "refresh_token_revoked"
  | "invalid_grant"
  | "token_expired"
  | "fetch_failed"
  | "timeout"
  | "recusado"
  | "desconhecido";

/** Sinais, em ordem de prioridade — os primeiros são mais específicos. */
const SINAIS_DA_RECUSA: ReadonlyArray<{ motivo: MotivoDaRecusaDeRenovacao; sinal: RegExp }> = [
  { motivo: "timeout", sinal: /timeout|timed out|aborted|abort/ },
  { motivo: "fetch_failed", sinal: /fetch failed|econnrefused|econnreset|enotfound|network|socket/ },
  { motivo: "refresh_token_revoked", sinal: /revoked|revog/ },
  { motivo: "invalid_grant", sinal: /invalid_grant/ },
  { motivo: "token_expired", sinal: /expir|vencid/ },
];

/**
 * Traduz o erro da renovação no rótulo do motivo. Puro e sem rede: é a única
 * parte desta decisão que precisa de casos, e ela é testada sem banco.
 *
 * O `motivo` do `ErroDeToken` vem primeiro quando já é específico
 * (`refresh_token_revoked`), porque a classificação dele lê o CORPO do provedor
 * e é mais confiável que o texto da exceção.
 */
export function detalheDaRecusaDeRenovacao(erro: unknown): MotivoDaRecusaDeRenovacao {
  const motivoDoToken = (erro as { motivo?: unknown } | null)?.motivo;
  if (motivoDoToken === "refresh_token_revoked") return "refresh_token_revoked";
  const nome = (erro as { name?: unknown } | null)?.name;
  const texto = `${typeof nome === "string" ? nome : ""} ${
    erro instanceof Error ? erro.message : String(erro)
  }`.toLowerCase();
  for (const { motivo, sinal } of SINAIS_DA_RECUSA) {
    if (sinal.test(texto)) return motivo;
  }
  if (motivoDoToken === "recusado") return "recusado";
  if (motivoDoToken === "rede") return "fetch_failed";
  return "desconhecido";
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
