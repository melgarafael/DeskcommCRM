/**
 * Onde as duas leituras viram UMA tabela.
 *
 * Puro de propósito: nenhuma rede, nenhum client, nenhuma data implícita. Toda a
 * lógica que pode errar em silêncio — cruzar por id, tolerar campo ausente,
 * calcular derivada — mora aqui, onde um teste unitário a alcança sem token e
 * sem cota. `insights.ts` sabe do fio e não sabe cruzar; este arquivo sabe
 * cruzar e não sabe do fio.
 *
 * ─── Por que cruzar por `campaign_id`, e nunca por nome ─────────────────────
 *
 * Não é boa prática abstrata: a conta sondada em 2026-09-02 tem DUAS campanhas
 * chamadas "Engajamento: Astra Mídia" — `120254899459370350` (ativa) e
 * `120251391310830350` (pausada). Cruzar por nome fundiria as duas numa linha e
 * mostraria o status de uma com o gasto da outra. A plataforma não impede nomes
 * repetidos, então o código não pode depender de eles serem únicos.
 *
 * ─── Por que TUDO é tolerante a ausência ────────────────────────────────────
 *
 * Campanha que não veiculou no período volta sem `cpm`, sem `ctr`, sem `cpc`, e
 * com `results: [{ indicator: "…" }]` — o indicador presente e o `values`
 * AUSENTE. Quatro das sete campanhas da conta sondada estavam nesse estado. Um
 * acesso encadeado ingênuo (`results[0].values[0].value`) estoura na maioria das
 * linhas reais, e o `?? 0` que "resolve" mente: "CTR 0,00%" afirma que houve
 * medição e deu zero. Aqui a ausência vira `null` e a tela mostra "—".
 */
import type { CampanhaCrua, LinhaDeInsightCrua, MetricaIndicada, AcaoDeVideo } from "./insights";
import type { LinhaDeCampanha, ResultadoDaCampanha } from "../types";

/**
 * Rótulo legível para o `indicator` que a plataforma devolve.
 *
 * A chave é o action_type já sem o prefixo `actions:`. O mapa cobre o que
 * aparece nas contas reais desta casa; o que não estiver aqui cai no fallback,
 * que é o próprio action_type legibilizado — pior que um rótulo humano, MELHOR
 * que uma coluna "Resultado: 15" sem dizer 15 do quê.
 *
 * Os rótulos são as chaves do dicionário de i18n (`lib/i18n/dicionario.ts`).
 */
export const ROTULO_POR_INDICADOR: Record<string, string> = {
  "onsite_conversion.messaging_conversation_started_7d": "Conversas iniciadas",
  "onsite_conversion.messaging_first_reply": "Primeiras respostas",
  "offsite_conversion.fb_pixel_lead": "Cadastros",
  "offsite_conversion.fb_pixel_purchase": "Compras",
  "offsite_conversion.fb_pixel_complete_registration": "Registros concluídos",
  "offsite_conversion.fb_pixel_add_to_cart": "Adições ao carrinho",
  "offsite_conversion.fb_pixel_initiate_checkout": "Checkouts iniciados",
  onsite_conversion_lead_grouped: "Cadastros",
  lead: "Cadastros",
  leadgen_grouped: "Cadastros de formulário",
  link_click: "Cliques no link",
  landing_page_view: "Visualizações da página",
  post_engagement: "Engajamentos",
  page_engagement: "Engajamentos da página",
  video_view: "Visualizações de vídeo",
  purchase: "Compras",
  app_install: "Instalações do app",
  reach: "Alcance",
  impressions: "Impressões",
};

/** `actions:offsite_conversion.fb_pixel_lead` → `offsite_conversion.fb_pixel_lead`. */
export function limparIndicador(indicador: string | null): string | null {
  if (!indicador) return null;
  return indicador.startsWith("actions:") ? indicador.slice("actions:".length) : indicador;
}

/**
 * O rótulo para a tela. Fallback legibiliza o action_type cru em vez de esconder
 * a coluna: saber que são "fb pixel custom" é pouco, mas é mais que nada.
 */
export function rotuloDoIndicador(indicador: string | null): string | null {
  const limpo = limparIndicador(indicador);
  if (!limpo) return null;
  return ROTULO_POR_INDICADOR[limpo] ?? limpo.replace(/[._]/g, " ");
}

/**
 * String da plataforma → número, ou `null`.
 *
 * `null` e não `0`, sempre. A plataforma manda tudo como string, inclusive
 * `"0"`; distinguir "veio zero" de "não veio" é o que separa uma métrica medida
 * de uma métrica ausente, e a tela mostra as duas de formas diferentes.
 */
export function numeroOuNulo(valor: string | number | undefined | null): number | null {
  if (valor === undefined || valor === null || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrai o primeiro valor de uma métrica rotulada (`results`, `cost_per_result`).
 *
 * Cada passo pode faltar, e o caso do `values` ausente com `indicator` presente
 * é o COMUM, não o raro — ver o cabeçalho.
 */
export function valorIndicado(metrica: MetricaIndicada[] | undefined): {
  valor: number | null;
  indicador: string | null;
} {
  const primeira = metrica?.[0];
  if (!primeira) return { valor: null, indicador: null };
  return {
    valor: numeroOuNulo(primeira.values?.[0]?.value),
    indicador: primeira.indicator ?? null,
  };
}

/**
 * Soma as entradas de uma métrica de vídeo.
 *
 * Soma em vez de pegar `[0]`: a lista é por action_type, e embora as contas
 * sondadas só tenham `video_view`, nada na plataforma garante entrada única.
 * Lista vazia devolve `null`, não `0` — campanha sem vídeo não teve zero
 * reproduções, ela não tem a métrica.
 */
export function somaDeAcoes(acoes: AcaoDeVideo[] | undefined): number | null {
  if (!acoes || acoes.length === 0) return null;
  let total = 0;
  let houve = false;
  for (const acao of acoes) {
    const n = numeroOuNulo(acao.value);
    if (n !== null) {
      total += n;
      houve = true;
    }
  }
  return houve ? total : null;
}

/**
 * Hook Rate = reproduções de vídeo ÷ impressões × 100.
 *
 * ⚠️ O numerador NÃO é o clássico. O Hook Rate de mercado usa reproduções de 3
 * segundos, e `video_3_sec_watched_actions` FOI REMOVIDO da v22.0 (erro 100 ao
 * pedi-lo). O substituto aparente, `video_continuous_2_sec_watched_actions`, é
 * aceito e volta vazio mesmo em campanha com vídeo — verificado na conta real.
 * Sobra `video_play_actions`, que conta INÍCIOS de reprodução e portanto produz
 * um número MAIOR que o hook rate de 3s a que o operador está acostumado.
 *
 * Por isso a tela rotula a coluna com o numerador em vez de só "Hook Rate": um
 * número que não bate com o Gerenciador e não explica por quê é pior que
 * nenhum. Se a plataforma devolver o campo de 3s de volta, troque AQUI e o
 * rótulo junto.
 */
export function calcularHookRate(
  reproducoes: number | null,
  impressoes: number | null,
): number | null {
  if (reproducoes === null || impressoes === null || impressoes === 0) return null;
  return (reproducoes / impressoes) * 100;
}

/**
 * O custo por resultado, com fallback declarado.
 *
 * A plataforma manda `cost_per_result` pronto, e ele é a fonte preferida: é o
 * mesmo número do Gerenciador, já com a janela de atribuição dela. O cálculo
 * `gasto ÷ resultado` só entra quando ele falta E há gasto E há resultado — e
 * divisão por zero devolve `null`, não `Infinity`, que a tela renderizaria como
 * "∞" ao lado de um valor em reais.
 */
export function custoPorResultado(
  daPlataforma: number | null,
  gasto: number | null,
  resultado: number | null,
): number | null {
  if (daPlataforma !== null) return daPlataforma;
  if (gasto === null || resultado === null || resultado === 0) return null;
  return gasto / resultado;
}

function extrairResultado(linha: LinhaDeInsightCrua): ResultadoDaCampanha {
  const resultado = valorIndicado(linha.results);
  const custo = valorIndicado(linha.cost_per_result);
  const gasto = numeroOuNulo(linha.spend);

  return {
    valor: resultado.valor,
    custoPorResultado: custoPorResultado(custo.valor, gasto, resultado.valor),
    // O indicador de `results` manda; o de `cost_per_result` é o mesmo na
    // prática, e usá-lo como reserva cobre a linha que traz um e não o outro.
    indicador: resultado.indicador ?? custo.indicador,
  };
}

/**
 * Cruza campanhas e insights numa tabela.
 *
 * ─── Quem entra na tabela, e por quê ────────────────────────────────────────
 *
 * A UNIÃO dos dois lados, e não a interseção, porque cada ausência é uma
 * informação diferente e nenhuma delas é "a campanha não existe":
 *
 *  - Em insights e em campanhas → o caso normal.
 *  - Só em insights → a campanha foi apagada entre as duas chamadas (são duas
 *    requisições, não uma transação). Os números são reais e ficam; status e
 *    veiculação viram `null`. Descartá-la sumiria com gasto que aconteceu.
 *  - Só em campanhas → existe e não veiculou no período. Entra com métricas
 *    `null`. Descartá-la faria o operador procurar por uma campanha que ele
 *    acabou de criar e concluir que a tela está quebrada.
 *
 * A ordem é a de insights primeiro (quem gastou aparece antes), com as
 * sem-veiculação no fim.
 */
export function montarTabelaDeCampanhas(
  campanhas: CampanhaCrua[],
  insights: LinhaDeInsightCrua[],
): LinhaDeCampanha[] {
  const porId = new Map<string, CampanhaCrua>();
  for (const campanha of campanhas) {
    if (campanha.id) porId.set(campanha.id, campanha);
  }

  const vistos = new Set<string>();
  const linhas: LinhaDeCampanha[] = [];

  for (const insight of insights) {
    const id = insight.campaign_id;
    if (!id) continue;
    vistos.add(id);
    const campanha = porId.get(id);

    const impressoes = numeroOuNulo(insight.impressions);
    const reproducoes = somaDeAcoes(insight.video_play_actions);

    linhas.push({
      campanhaId: id,
      // O nome do insight é o do período; o do cadastro é o atual. Preferir o
      // cadastro faz a tabela concordar com o Gerenciador depois de uma
      // renomeação.
      nome: campanha?.name ?? insight.campaign_name ?? id,
      status: campanha?.status ?? null,
      veiculacao: campanha?.effective_status ?? null,
      objetivo: campanha?.objective ?? null,
      resultado: extrairResultado(insight),
      gasto: numeroOuNulo(insight.spend),
      impressoes,
      alcance: numeroOuNulo(insight.reach),
      cpm: numeroOuNulo(insight.cpm),
      ctr: numeroOuNulo(insight.ctr),
      frequencia: numeroOuNulo(insight.frequency),
      cpc: numeroOuNulo(insight.cpc),
      hookRate: calcularHookRate(reproducoes, impressoes),
      thruPlays: somaDeAcoes(insight.video_thruplay_watched_actions),
    });
  }

  for (const campanha of campanhas) {
    if (!campanha.id || vistos.has(campanha.id)) continue;
    linhas.push({
      campanhaId: campanha.id,
      nome: campanha.name ?? campanha.id,
      status: campanha.status ?? null,
      veiculacao: campanha.effective_status ?? null,
      objetivo: campanha.objective ?? null,
      resultado: { valor: null, custoPorResultado: null, indicador: null },
      gasto: null,
      impressoes: null,
      alcance: null,
      cpm: null,
      ctr: null,
      frequencia: null,
      cpc: null,
      hookRate: null,
      thruPlays: null,
    });
  }

  return linhas;
}
