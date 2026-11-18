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
import type { CampanhaCrua, LinhaDeInsightCrua, MetricaIndicada, AcaoDaPlataforma } from "./insights";
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
export function somaDeAcoes(acoes: AcaoDaPlataforma[] | undefined): number | null {
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
 * Os `action_type` que contam como visualização da página, em ordem de preferência.
 *
 * A lista de `actions` chega heterogênea (`link_click`, `post_engagement`,
 * `video_view`, conversas…) e a plataforma pode rotular a MESMA visualização de
 * página com dois nomes: `landing_page_view` e, em contas que medem conversão
 * omnicanal, `omni_landing_page_view`. Procurar os dois, nesta ordem, evita uma
 * coluna inteira de "—" por causa do nome de um campo.
 *
 * ⚠️ A variante `omni_` NÃO foi confirmada numa conta real nesta sessão (não
 * houve token sondável). Se a plataforma nunca mandar esse rótulo, a linha é
 * inofensiva; se mandar, é ela que salva a coluna. Se algum dia o Gerenciador
 * discordar do número, olhe AQUI primeiro.
 */
const TIPOS_DE_VISUALIZACAO_DA_PAGINA = [
  "landing_page_view",
  "omni_landing_page_view",
] as const;

/**
 * O valor de UMA ação pelo `action_type`, ou `null`.
 *
 * Não é `somaDeAcoes`: aqui a lista é heterogênea, e somar misturaria cliques
 * com conversas e reproduções. O que se quer é o número de UM tipo, e `null`
 * quando esse tipo não veio — que é diferente de ter vindo zero.
 */
export function valorDaAcao(
  acoes: AcaoDaPlataforma[] | undefined,
  tipos: readonly string[] = TIPOS_DE_VISUALIZACAO_DA_PAGINA,
): number | null {
  if (!acoes || acoes.length === 0) return null;
  for (const tipo of tipos) {
    const n = numeroOuNulo(acoes.find((acao) => acao.action_type === tipo)?.value);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Connect rate = visualizações da página ÷ cliques no link × 100.
 *
 * É a conta do Gerenciador de Anúncios, com os dois números do mercado. Por
 * isso a coluna NÃO leva o numerador escrito no rótulo, como o Hook Rate leva:
 * lá o numerador diverge do de mercado e precisa avisar; aqui não diverge.
 *
 * Denominador zero devolve `null` ("—"), nunca `Infinity`: campanha com
 * visualização de página e sem clique registrado é dado inconsistente, e "∞%"
 * na tela seria pior que a ausência.
 */
export function calcularConnectRate(
  visualizacoesDaPagina: number | null,
  cliquesNoLink: number | null,
): number | null {
  if (visualizacoesDaPagina === null || cliquesNoLink === null || cliquesNoLink === 0) {
    return null;
  }
  return (visualizacoesDaPagina / cliquesNoLink) * 100;
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
 * As ordens que a tela oferece para a tabela (#3911).
 *
 * `mais_recentes` é o PADRÃO, e o motivo está na issue: quem abre a aba quer ver
 * o que está rodando ou acabou de rodar, e a plataforma devolve a lista das mais
 * antigas para as mais novas — ou seja, a campanha do dia ficava no fim.
 *
 * As métricas (gasto, resultado, custo por resultado) NÃO estão aqui de
 * propósito: elas existem no payload, mas ordenar por elas exige decidir o que
 * fazer com linha de métrica ausente (que neste módulo é `null`, não zero) e
 * isso é outra fatia. Entrar com duas opções que ordenam "pelo que veio" já
 * resolve o defeito relatado sem inventar semântica.
 */
export type CriterioDeOrdenacao = "mais_recentes" | "mais_antigas" | "status";

/** A ordem em que a tabela abre quando ninguém escolheu nada. */
export const ORDEM_PADRAO: CriterioDeOrdenacao = "mais_recentes";

/**
 * Data da plataforma (`2026-08-14T09:31:10+0000`) → milissegundos, ou `null`.
 *
 * `Date.parse` em vez de comparar as strings: as strings têm offset, e comparar
 * texto colocaria uma campanha de `-0300` no lugar errado. `NaN` (formato que a
 * plataforma mudou) vira `null`, e `null` é "sem data" — nunca 1970, que faria
 * a linha sem data parecer a mais antiga de todas e descer a lista inteira.
 */
function instante(valor: string | null | undefined): number | null {
  if (!valor) return null;
  const ms = Date.parse(valor);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Compara dois instantes, com a ausência SEMPRE no fim — nas duas direções.
 *
 * Inverter o sinal inteiro para "mais antigas" mandaria as linhas sem data para
 * o TOPO, que é o pior lugar possível para a linha de que menos se sabe. Por
 * isso a direção vale só entre dois instantes conhecidos.
 */
function compararInstantes(
  a: number | null,
  b: number | null,
  maisRecentePrimeiro: boolean,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return maisRecentePrimeiro ? b - a : a - b;
}

/** Criação manda; `start_time` desempata (duas campanhas do mesmo rascunho). */
function compararPorData(
  a: LinhaDeCampanha,
  b: LinhaDeCampanha,
  maisRecentePrimeiro: boolean,
): number {
  const porCriacao = compararInstantes(
    instante(a.criadaEm),
    instante(b.criadaEm),
    maisRecentePrimeiro,
  );
  if (porCriacao !== 0) return porCriacao;
  return compararInstantes(instante(a.iniciadaEm), instante(b.iniciadaEm), maisRecentePrimeiro);
}

/**
 * A faixa de cada linha na ordem "ativas primeiro".
 *
 * Usa `effective_status` (a `veiculacao` da tela) e não o `status` do cadastro:
 * campanha com status ACTIVE e pai pausado NÃO está entregando, e é justamente
 * essa a pergunta que traz alguém a esta aba. `null` — linha que veio só de
 * insights — fica por último: não se sabe o estado, então não se afirma que ela
 * esteja ativa.
 */
function faixaDeStatus(linha: LinhaDeCampanha): number {
  const estado = linha.veiculacao ?? linha.status;
  if (estado === null) return 2;
  return estado === "ACTIVE" ? 0 : 1;
}

/**
 * Ordena as linhas para a tela, sem tocar no array recebido.
 *
 * `sort` é estável por especificação, e é disso que a tabela depende: entre
 * linhas EMPATADAS (mesma data, ou todas sem data) a ordem de montagem é
 * preservada — insights primeiro, cadastro sem veiculação depois. Ordenar não
 * reescreve a regra de quem entrou na tabela, só a ordem de leitura.
 */
export function ordenarCampanhas(
  linhas: readonly LinhaDeCampanha[],
  criterio: CriterioDeOrdenacao = ORDEM_PADRAO,
): LinhaDeCampanha[] {
  const ordenadas = [...linhas];
  // Critério desconhecido (valor de um `select` que mudou de vocabulário, por
  // exemplo) cai na PADRÃO — nunca em "ordem de entrada", que é o defeito que
  // esta função existe para consertar.
  const efetivo: CriterioDeOrdenacao =
    criterio === "mais_antigas" || criterio === "status" ? criterio : ORDEM_PADRAO;
  if (efetivo === "status") {
    ordenadas.sort(
      (a, b) => faixaDeStatus(a) - faixaDeStatus(b) || compararPorData(a, b, true),
    );
    return ordenadas;
  }
  ordenadas.sort((a, b) => compararPorData(a, b, efetivo === "mais_recentes"));
  return ordenadas;
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
 * A ordem é a PADRÃO da tela (#3911): da campanha mais recente para a mais
 * antiga, por `created_time` (o `start_time` desempata). Antes disso a ordem era
 * a da plataforma — das mais antigas para as mais novas —, e a campanha que
 * estava rodando aparecia no fim da tabela. Quem empata continua na ordem de
 * montagem (insights primeiro, sem-veiculação depois), porque `sort` é estável.
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
    // Os dois números do Connect rate vêm do MESMO payload de insights — ver
    // CAMPOS_DE_INSIGHTS: `actions` rotula a visualização da página e
    // `inline_link_clicks` conta os cliques no link.
    const connectRate = calcularConnectRate(
      valorDaAcao(insight.actions),
      numeroOuNulo(insight.inline_link_clicks),
    );

    linhas.push({
      campanhaId: id,
      // O nome do insight é o do período; o do cadastro é o atual. Preferir o
      // cadastro faz a tabela concordar com o Gerenciador depois de uma
      // renomeação.
      nome: campanha?.name ?? insight.campaign_name ?? id,
      status: campanha?.status ?? null,
      veiculacao: campanha?.effective_status ?? null,
      objetivo: campanha?.objective ?? null,
      // Sem cadastro não há data: a linha veio só do insight (campanha
      // apagada entre as duas chamadas). `null` é a verdade, e a ordenação a
      // manda para o fim.
      criadaEm: campanha?.created_time ?? null,
      iniciadaEm: campanha?.start_time ?? null,
      resultado: extrairResultado(insight),
      gasto: numeroOuNulo(insight.spend),
      impressoes,
      alcance: numeroOuNulo(insight.reach),
      cpm: numeroOuNulo(insight.cpm),
      ctr: numeroOuNulo(insight.ctr),
      connectRate,
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
      criadaEm: campanha.created_time ?? null,
      iniciadaEm: campanha.start_time ?? null,
      resultado: { valor: null, custoPorResultado: null, indicador: null },
      gasto: null,
      impressoes: null,
      alcance: null,
      cpm: null,
      ctr: null,
      connectRate: null,
      frequencia: null,
      cpc: null,
      hookRate: null,
      thruPlays: null,
    });
  }

  return ordenarCampanhas(linhas);
}
