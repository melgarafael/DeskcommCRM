/**
 * A REGRA ÚNICA DO CUSTO DE UMA CHAMADA QUE JÁ SAIU (issue #4697).
 *
 * ═══ O DEFEITO MEDIDO ═══
 *
 * Numa instalação real, chamadas do MESMO provedor/modelo/propósito saíam com
 * `cost_cents` preenchido em umas e NULL em outras, no mesmo dia (271 de 457
 * turnos entre 22/10 e 02/11/2026, provedor `openai-assinatura`, modelo
 * `gpt-6-astra`). O que decide gravar ou não estava espalhado em três `??`
 * encadeados no meio do seam (`run-model-call.ts`), e a decisão de cada caminho
 * era invisível — não havia um lugar que dissesse "esta chamada, neste
 * caminho, grava este custo".
 *
 * Medido no seam (teste desta frente): para um modelo que a tabela do motor
 * conhece, o caminho de SUCESSO grava número sempre, e `null` só aparece
 * (a) quando nenhum dos dois catálogos conhece o modelo — `costCents` devolve
 * `null` (`pricing.ts`) e `custoDoModeloForaDoMotor` também —, ou (b) na linha
 * de FALHA, que grava `cost_cents` nulo de propósito porque a chamada não
 * consumiu nada (`registrarFalha`). O efeito de fora é o mesmo: a coluna não
 * distingue "não sei o preço" de "não houve uso".
 *
 * ═══ A REGRA, EM ORDEM, NUM LUGAR SÓ ═══
 *
 *  1. O provedor INFORMOU quanto cobrou (OpenRouter oficial, `usage.cost`):
 *     vale o número dele.
 *  2. Tabela do motor (`pricing.ts`): para modelos com faixa de contexto
 *     longo, vale a soma dos custos calculados por passo. Quando o
 *     provedor é a ASSINATURA, esse número é EQUIVALENTE DE API — não é
 *     dinheiro que saiu da conta —, e por isso sai marcado
 *     (`equivalente_de_api_da_assinatura`). A marca é o que a issue pede:
 *     "sempre o preço equivalente (marcado como tal) OU sempre zero".
 *  3. Catálogo da instalação (`ai_models`/`ai_pricing`).
 *  4. Nada disso: `null` — "não sei", nunca 0 inventado —, e o motivo
 *     (`sem_preco`) vai junto para quem registra. Custo nulo CALADO é o
 *     defeito; custo nulo declarado é a doutrina da coluna.
 *
 * Antes do preço de tabela há um corte de DADO: se o provedor não
 * mediu uso nenhum (`temUso: false`), o desfecho é `null` com motivo `sem_uso`.
 * Sem esse corte, `preço × 0 token` devolvia `0` — "esta chamada foi de graça" —
 * para a resposta que só não trouxe `usage`. É a diferença entre "não custou
 * nada" e "não sabemos quanto consumiu", e é a que a coluna tem de guardar.
 *
 * ═══ POR QUE "SEMPRE O EQUIVALENTE", E NÃO "SEMPRE ZERO" ═══
 *
 * Os dois leitores da coluna — o painel de custo (`app/api/v1/admin/usage`,
 * `app/app/ai/usage`) e o teto de gasto (`fn_gasto_de_ia_do_mes`, chamada pelo
 * gate) — somam `coalesce(cost_cents, 0)` e nada mais. Zero seria
 * indistinguível de "grátis" para os dois e apagaria a comparação entre dias e
 * entre provedores; o equivalente de API mantém o histórico comparável e é o
 * que as 186 linhas já preenchidas daquela instalação carregam. A marca que
 * separa "equivalente" de "dinheiro gasto" já existe na linha: a coluna
 * `provider` (`openai-assinatura`), que é por onde o painel agrupa.
 *
 * Este módulo é PURO de propósito: a decisão é testável sem banco, sem rede e
 * sem SDK, e o seam só resolve os valores e pergunta.
 */
import { PROVEDOR_POR_ASSINATURA } from '@/lib/ai/pontos/provedores';

/** De onde saiu o número gravado — o que o log e o painel precisam para explicar a linha. */
export type OrigemDoCusto =
  | 'informado_pelo_provedor'
  | 'equivalente_de_api_da_assinatura'
  | 'catalogo_da_instalacao'
  | 'sem_uso'
  | 'sem_preco';

/**
 * O provedor MEDIU o uso desta chamada?
 *
 * Existe porque `costCents` responde `0` — não `null` — quando o modelo tem
 * tarifa e o `usage` vem zerado (tarifa × 0 token). Num provedor que não devolve
 * `usage` (gateway caseiro, assinatura que corta o bloco, resposta truncada por
 * timeout), esse `0` entrava em `cost_cents` com cara de número medido: dizia
 * "esta chamada foi de graça" quando o que faltava era o DADO. Zero é ausência
 * de custo; ausência de uso é outra coisa, e a coluna tem de distinguir.
 *
 * Todo contador zerado = o provedor não mediu. Um `input` positivo com `output`
 * zero NÃO é "sem uso" (resposta vazia é uso de entrada), por isso o teste é
 * sobre a SOMA, não sobre cada campo.
 */
export function haUsoMedido(usage: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}): boolean {
  const soma =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  return Number.isFinite(soma) && soma > 0;
}

export interface CustoDecidido {
  /** Centavos de dólar, fracionados. `null` = nenhum catálogo conhece o modelo. */
  costCents: number | null;
  /**
   * `undefined` quando o número veio da tabela do motor num provedor comum — é
   * o caso de sempre, e marcar "tabela" em toda linha só ruído. A assinatura
   * SEMPRE marca (é o que a distingue de gasto), e `sem_preco` sempre marca.
   */
  origem: OrigemDoCusto | undefined;
}

export interface EntradaDoCusto {
  provider: string;
  /**
   * O provedor mediu o uso? `false` ⇒ a resposta não trouxe token nenhum, e o
   * preço de tabela vezes zero daria `0` — "de graça", que é mentira. Nesse
   * caso o desfecho é `null` com motivo `sem_uso`, distinto de `sem_preco`.
   * Obrigatório de propósito: cada chamador tem de OLHAR o `usage` que recebeu.
   */
  temUso: boolean;
  /** `usage.cost` somado dos passos, quando o provedor informou (OpenRouter oficial). */
  informadoPeloProvedor: number | undefined;
  /** Preço da tabela do motor, somado por passo se houver faixa longa. `null` quando não há preço. */
  daTabelaDoMotor: number | null;
  /** Preço da linha que a instalação cadastrou. Só é consultado quando a tabela não conhece. */
  doCatalogoDaInstalacao?: number | null;
}

export function decidirCustoDaChamada(e: EntradaDoCusto): CustoDecidido {
  if (e.informadoPeloProvedor !== undefined) {
    return { costCents: e.informadoPeloProvedor, origem: 'informado_pelo_provedor' };
  }
  // ANTES da tabela: sem uso medido, todo preço de tabela dá 0. `0` aqui seria
  // "não custou nada" e o que aconteceu foi "não sabemos quanto consumiu".
  if (!e.temUso) {
    return { costCents: null, origem: 'sem_uso' };
  }
  if (e.daTabelaDoMotor !== null) {
    return {
      costCents: e.daTabelaDoMotor,
      // A assinatura não cobra por token: o preço da tabela é o EQUIVALENTE de
      // API. Sem esta marca, a linha diria "gastei US$ 0,015" quando a conta
      // não foi tocada — foi a queixa da #4697.
      origem: e.provider === PROVEDOR_POR_ASSINATURA ? 'equivalente_de_api_da_assinatura' : undefined,
    };
  }
  if (e.doCatalogoDaInstalacao !== undefined && e.doCatalogoDaInstalacao !== null) {
    return { costCents: e.doCatalogoDaInstalacao, origem: 'catalogo_da_instalacao' };
  }
  return { costCents: null, origem: 'sem_preco' };
}
