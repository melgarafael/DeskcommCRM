import { describe, expect, it } from "vitest";

import type { CampanhaCrua, LinhaDeInsightCrua } from "@/lib/plataformas-de-anuncio/meta/insights";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";
import {
  calcularConnectRate,
  calcularHookRate,
  custoPorResultado,
  montarTabelaDeCampanhas,
  numeroOuNulo,
  rotuloDoIndicador,
  somaDeAcoes,
  valorDaAcao,
  valorIndicado,
} from "@/lib/plataformas-de-anuncio/meta/tabela-de-campanhas";

/**
 * A TABELA NÃO PODE MENTIR NEM QUEBRAR.
 *
 * Os casos aqui não são hipóteses: TODOS saem de uma sondagem real contra a
 * Graph API v22.0 em 2026-09-02, na conta `act_895609843551472`. É por isso que
 * os fixtures têm formato estranho — o formato estranho é o que a plataforma
 * manda de verdade, e cada um deles quebra uma implementação ingênua:
 *
 *  - 4 das 7 campanhas voltaram SEM `cpm`/`ctr`/`cpc` e com `results` trazendo
 *    `indicator` e nenhum `values`.
 *  - 2 campanhas diferentes têm o MESMO nome.
 *  - Campos de vídeo aparecem só onde há vídeo, e somem no resto.
 */

// ─── Fixtures colhidos da API viva ──────────────────────────────────────────

/** Campanha que veiculou, com vídeo. Números reais. */
const CADASTRO_AGENDA_CHEIA: LinhaDeInsightCrua = {
  campaign_id: "120254402954150350",
  campaign_name: "Cadastro: Agenda Cheia",
  spend: "364.63",
  impressions: "21281",
  reach: "13894",
  cpm: "17.134063",
  ctr: "2.020582",
  frequency: "1.531668",
  cpc: "0.847977",
  results: [
    {
      indicator: "actions:offsite_conversion.fb_pixel_lead",
      values: [{ value: "13" }],
    },
  ],
  cost_per_result: [
    {
      indicator: "actions:offsite_conversion.fb_pixel_lead",
      values: [{ value: "28.04846154" }],
    },
  ],
  video_play_actions: [{ action_type: "video_view", value: "415" }],
  video_thruplay_watched_actions: [{ action_type: "video_view", value: "7" }],
};

/**
 * Campanha SEM veiculação no período — o caso que quebra o acesso encadeado.
 * `results` tem indicador e NÃO tem `values`; `cpm`/`ctr`/`cpc` sumiram.
 */
const SEM_VEICULACAO: LinhaDeInsightCrua = {
  campaign_id: "120251391310830350",
  campaign_name: "Engajamento: Astra Mídia",
  spend: "0",
  impressions: "0",
  reach: "0",
  frequency: "0",
  results: [{ indicator: "actions:onsite_conversion.messaging_conversation_started_7d" }],
  cost_per_result: [{ indicator: "actions:onsite_conversion.messaging_conversation_started_7d" }],
};

/** Campanha sem NENHUM `results` — nem indicador. Também real. */
const SEM_RESULTS: LinhaDeInsightCrua = {
  campaign_id: "120253957246210350",
  campaign_name: "Formulário: Astra Mídia (Engenheiros)",
  spend: "0",
  impressions: "0",
  reach: "0",
  frequency: "0",
};

/**
 * As duas campanhas homônimas da conta real. Nomes idênticos, ids diferentes,
 * status diferentes.
 */
const CAMPANHAS: CampanhaCrua[] = [
  {
    id: "120254899459370350",
    name: "Engajamento: Astra Mídia",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    objective: "OUTCOME_ENGAGEMENT",
  },
  {
    id: "120251391310830350",
    name: "Engajamento: Astra Mídia",
    status: "PAUSED",
    effective_status: "PAUSED",
    objective: "OUTCOME_ENGAGEMENT",
  },
  {
    id: "120254402954150350",
    name: "Cadastro: Agenda Cheia",
    status: "PAUSED",
    effective_status: "PAUSED",
    objective: "OUTCOME_LEADS",
  },
  {
    id: "120253957246210350",
    name: "Formulário: Astra Mídia (Engenheiros)",
    status: "PAUSED",
    effective_status: "PAUSED",
    objective: "OUTCOME_LEADS",
  },
];

/**
 * A primeira linha, com a asserção que o `noUncheckedIndexedAccess` do
 * tsconfig exige. Um `!` aqui calaria o compilador e trocaria a falha legível
 * ("esperava ao menos uma linha") por um `TypeError` de propriedade de
 * undefined, três frames abaixo.
 */
function primeira(linhas: LinhaDeCampanha[]): LinhaDeCampanha {
  const [linha] = linhas;
  if (!linha) throw new Error("esperava ao menos uma linha na tabela");
  return linha;
}

// ─── Os testes ──────────────────────────────────────────────────────────────

describe("ausência não vira zero", () => {
  it("distingue métrica ausente de métrica que veio zerada", () => {
    // "0" é medição: a campanha rodou e gastou zero.
    expect(numeroOuNulo("0")).toBe(0);
    // undefined é ausência: não houve medição. Um `?? 0` aqui faria a tela
    // afirmar "CTR 0,00%" onde a verdade é "não medido".
    expect(numeroOuNulo(undefined)).toBeNull();
    expect(numeroOuNulo(null)).toBeNull();
    expect(numeroOuNulo("")).toBeNull();
    expect(numeroOuNulo("abc")).toBeNull();
  });

  it("campanha sem veiculação não inventa CPM, CTR nem CPC", () => {
    const linha = primeira(montarTabelaDeCampanhas(CAMPANHAS, [SEM_VEICULACAO]));
    expect(linha.cpm).toBeNull();
    expect(linha.ctr).toBeNull();
    expect(linha.cpc).toBeNull();
    // Estes VIERAM zerados — e zero medido é diferente de ausente.
    expect(linha.gasto).toBe(0);
    expect(linha.impressoes).toBe(0);
  });
});

describe("results sem values — o formato que quebra o acesso ingênuo", () => {
  it("extrai indicador mesmo quando `values` não veio", () => {
    const extraido = valorIndicado(SEM_VEICULACAO.results);
    expect(extraido.valor).toBeNull();
    expect(extraido.indicador).toBe("actions:onsite_conversion.messaging_conversation_started_7d");
  });

  it("não estoura em campanha sem `results` nenhum", () => {
    expect(() => montarTabelaDeCampanhas(CAMPANHAS, [SEM_RESULTS])).not.toThrow();
    const linha = primeira(montarTabelaDeCampanhas(CAMPANHAS, [SEM_RESULTS]));
    expect(linha.resultado).toEqual({ valor: null, custoPorResultado: null, indicador: null });
  });

  it("monta a tabela inteira das 3 linhas reais sem lançar", () => {
    const linhas = montarTabelaDeCampanhas(CAMPANHAS, [
      CADASTRO_AGENDA_CHEIA,
      SEM_VEICULACAO,
      SEM_RESULTS,
    ]);
    // 3 de insights + 1 que só existe no cadastro (a homônima ativa).
    expect(linhas).toHaveLength(4);
  });
});

describe("cruzamento por id, nunca por nome", () => {
  it("mantém as duas campanhas homônimas separadas, com status distintos", () => {
    const linhas = montarTabelaDeCampanhas(CAMPANHAS, [SEM_VEICULACAO]);
    const homonimas = linhas.filter((l) => l.nome === "Engajamento: Astra Mídia");

    expect(homonimas).toHaveLength(2);
    // A que veio no insights é a PAUSADA; a ativa entra pelo cadastro.
    const pausada = homonimas.find((l) => l.campanhaId === "120251391310830350");
    const ativa = homonimas.find((l) => l.campanhaId === "120254899459370350");
    expect(pausada?.veiculacao).toBe("PAUSED");
    expect(ativa?.veiculacao).toBe("ACTIVE");
    // A pausada tem os números do insight; a ativa não veio no insight.
    expect(pausada?.impressoes).toBe(0);
    expect(ativa?.impressoes).toBeNull();
  });

  it("insight órfão (campanha apagada entre as duas chamadas) preserva os números", () => {
    const orfa: LinhaDeInsightCrua = {
      campaign_id: "999999999999",
      campaign_name: "Campanha apagada",
      spend: "50.00",
      impressions: "1000",
    };
    const linha = primeira(montarTabelaDeCampanhas([], [orfa]));
    expect(linha.gasto).toBe(50);
    expect(linha.impressoes).toBe(1000);
    // Sem cadastro, não há como saber o estado — e `null` diz isso.
    expect(linha.status).toBeNull();
    expect(linha.veiculacao).toBeNull();
  });

  it("campanha sem insight aparece com métricas nulas, não some da tabela", () => {
    const linhas = montarTabelaDeCampanhas(CAMPANHAS, []);
    expect(linhas).toHaveLength(4);
    expect(linhas.every((l) => l.gasto === null)).toBe(true);
    // O estado vem do cadastro e continua legível.
    expect(linhas.every((l) => l.veiculacao !== null)).toBe(true);
  });

  it("prefere o nome do cadastro ao do insight (renomeação recente)", () => {
    const renomeada: LinhaDeInsightCrua = {
      campaign_id: "120254402954150350",
      campaign_name: "Nome antigo do período",
      spend: "10",
    };
    const linha = primeira(montarTabelaDeCampanhas(CAMPANHAS, [renomeada]));
    expect(linha.nome).toBe("Cadastro: Agenda Cheia");
  });
});

describe("métricas de vídeo", () => {
  it("campanha só de imagem fica com Hook Rate e ThruPlays vazios", () => {
    const linha = primeira(montarTabelaDeCampanhas(CAMPANHAS, [SEM_VEICULACAO]));
    expect(linha.hookRate).toBeNull();
    expect(linha.thruPlays).toBeNull();
  });

  it("calcula o Hook Rate com os números reais da conta sondada", () => {
    const linha = primeira(montarTabelaDeCampanhas(CAMPANHAS, [CADASTRO_AGENDA_CHEIA]));
    // 415 reproduções ÷ 21.281 impressões = 1,9501%
    expect(linha.hookRate).toBeCloseTo(1.9501, 3);
    expect(linha.thruPlays).toBe(7);
  });

  it("soma múltiplos action_types em vez de pegar só o primeiro", () => {
    expect(
      somaDeAcoes([
        { action_type: "video_view", value: "100" },
        { action_type: "outro", value: "50" },
      ]),
    ).toBe(150);
  });

  it("lista vazia é ausência, não zero", () => {
    expect(somaDeAcoes([])).toBeNull();
    expect(somaDeAcoes(undefined)).toBeNull();
  });

  it("não divide por zero quando não houve impressão", () => {
    expect(calcularHookRate(415, 0)).toBeNull();
    expect(calcularHookRate(null, 1000)).toBeNull();
  });
});

describe("custo por resultado", () => {
  it("prefere o número da plataforma ao cálculo próprio", () => {
    const linha = primeira(montarTabelaDeCampanhas(CAMPANHAS, [CADASTRO_AGENDA_CHEIA]));
    // 364,63 ÷ 13 daria 28,0485 — igual por coincidência aqui, mas a fonte
    // preferida é a da plataforma, que já aplica a janela de atribuição dela.
    expect(linha.resultado.custoPorResultado).toBeCloseTo(28.04846154, 6);
  });

  it("cai para gasto ÷ resultado quando a plataforma não manda o custo", () => {
    expect(custoPorResultado(null, 100, 4)).toBe(25);
  });

  it("não devolve Infinity quando o resultado é zero", () => {
    expect(custoPorResultado(null, 100, 0)).toBeNull();
    expect(custoPorResultado(null, null, 4)).toBeNull();
  });
});

describe("rótulo do indicador", () => {
  it("traduz os indicadores vistos na conta real", () => {
    expect(rotuloDoIndicador("actions:offsite_conversion.fb_pixel_lead")).toBe("Cadastros");
    expect(rotuloDoIndicador("actions:onsite_conversion.messaging_conversation_started_7d")).toBe(
      "Conversas iniciadas",
    );
  });

  it("legibiliza o desconhecido em vez de esconder a coluna", () => {
    expect(rotuloDoIndicador("actions:offsite_conversion.fb_pixel_custom")).toBe(
      "offsite conversion fb pixel custom",
    );
  });

  it("indicador ausente é nulo, não string vazia", () => {
    expect(rotuloDoIndicador(null)).toBeNull();
  });
});

// ─── Connect rate (issue #920) ───────────────────────────────────────────────
//
// ⚠️ Estes fixtures NÃO vieram de sondagem, ao contrário dos de cima: na sessão
// que escreveu esta coluna não havia token para bater na Graph API, e `actions`
// e `inline_link_clicks` são campos NOVOS no pedido — a conta sondada em
// 2026-09-02 nunca os devolveu. Os números são plausíveis (301 visualizações
// sobre 430 cliques no link = 70,0%) e o que estes casos provam é a CONTA, o
// recorte do numerador dentro de uma lista heterogênea, e o tratamento da
// ausência. Quando a primeira leitura real chegar, é aqui que ela vira fixture.

/** Só o que o Connect rate precisa, em cima da campanha que veiculou. */
const COM_CONNECT_RATE: LinhaDeInsightCrua = {
  ...CADASTRO_AGENDA_CHEIA,
  actions: [
    { action_type: "link_click", value: "430" },
    { action_type: "landing_page_view", value: "301" },
    { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "13" },
  ],
  inline_link_clicks: "430",
};

/** A primeira linha é sempre a de insights — a ordem é insights primeiro. */
function linhaDoInsight(insight: LinhaDeInsightCrua): LinhaDeCampanha {
  return primeira(montarTabelaDeCampanhas(CAMPANHAS, [insight]));
}

describe("Connect rate — visualizações da página ÷ cliques no link", () => {
  it("calcula o percentual como o Gerenciador de Anúncios", () => {
    expect(calcularConnectRate(301, 430)).toBeCloseTo(70, 5);
  });

  it("tira o numerador das `actions` e o denominador do `inline_link_clicks`", () => {
    expect(linhaDoInsight(COM_CONNECT_RATE).connectRate).toBeCloseTo(70, 5);
  });

  it("pega UMA ação pelo tipo, em vez de somar a lista inteira", () => {
    // Somar `actions` daria 744 (cliques + visualizações + conversas) e um
    // "Connect rate" de 173% — número absurdo com aparência de dado.
    expect(valorDaAcao(COM_CONNECT_RATE.actions)).toBe(301);
    expect(somaDeAcoes(COM_CONNECT_RATE.actions)).toBe(744);
  });

  it("`actions` sem `landing_page_view` fica nulo, não zero", () => {
    const semVisualizacao: LinhaDeInsightCrua = {
      ...COM_CONNECT_RATE,
      actions: [{ action_type: "link_click", value: "430" }],
    };
    expect(linhaDoInsight(semVisualizacao).connectRate).toBeNull();
  });

  it("sem `inline_link_clicks` fica nulo — campanha sem clique não tem taxa", () => {
    const semCliques: LinhaDeInsightCrua = {
      ...COM_CONNECT_RATE,
      inline_link_clicks: undefined,
    };
    expect(linhaDoInsight(semCliques).connectRate).toBeNull();
  });

  it("nem `actions` nem cliques em campanha que não veiculou", () => {
    // SEM_VEICULACAO é o caso comum — 4 das 7 campanhas reais voltaram assim.
    expect(linhaDoInsight(SEM_VEICULACAO).connectRate).toBeNull();
  });

  it("cliques zerados devolvem nulo, nunca Infinity", () => {
    expect(calcularConnectRate(301, 0)).toBeNull();
    expect(calcularConnectRate(0, 0)).toBeNull();
    const zerado: LinhaDeInsightCrua = { ...COM_CONNECT_RATE, inline_link_clicks: "0" };
    expect(linhaDoInsight(zerado).connectRate).toBeNull();
  });

  it("visualização zerada com cliques medidos dá 0, e não nulo", () => {
    // Aqui HOUVE medição e ela deu zero — a regra do arquivo: zero medido é
    // diferente de ausente.
    expect(calcularConnectRate(0, 430)).toBe(0);
  });

  it("aceita a variante omnicanal `omni_landing_page_view`", () => {
    expect(valorDaAcao([{ action_type: "omni_landing_page_view", value: "301" }])).toBe(301);
  });

  it("prefere `landing_page_view` quando as duas variantes vierem", () => {
    expect(
      valorDaAcao([
        { action_type: "omni_landing_page_view", value: "300" },
        { action_type: "landing_page_view", value: "301" },
      ]),
    ).toBe(301);
  });

  it("campanha que só existe no cadastro (sem insights) fica nula", () => {
    // A homônima ATIVA não apareceu nos insights do período.
    const linhas = montarTabelaDeCampanhas(CAMPANHAS, [COM_CONNECT_RATE]);
    const semInsight = linhas.find((linha) => linha.campanhaId === "120254899459370350");
    if (!semInsight) throw new Error("esperava a campanha que só existe no cadastro");
    expect(semInsight.connectRate).toBeNull();
  });
});
