/**
 * A regra de previsão ponderada (issue #1535), medida.
 *
 * Os critérios de aceite da issue viram `it` aqui — em particular o de que
 * R$ 10 mil + € 4 mil NUNCA vira um número só, e o de que "sem data" e "sem
 * probabilidade" aparecem em vez de virarem zero silencioso.
 */
import { describe, expect, it } from "vitest";

import {
  fontePrevisao,
  previsao,
  probabilidadeDoLead,
  type EtapaDaPrevisao,
  type LeadDaPrevisao,
} from "@/lib/leads/previsao";

const etapaDe = (
  id: string,
  extra: Partial<EtapaDaPrevisao> = {},
): EtapaDaPrevisao => ({
  id,
  name: id,
  is_won: false,
  is_lost: false,
  win_probability: null,
  ...extra,
});

const leadDe = (id: string, extra: Partial<LeadDaPrevisao> = {}): LeadDaPrevisao => ({
  id,
  stage_id: "qualificada",
  status: "open",
  value_cents: null,
  currency: "BRL",
  expected_close_date: null,
  ...extra,
});

/**
 * O balde esperado, com as duas parcelas declaradas.
 *
 * `unico` repete os campos planos porque é o que eles são desde a #3602 (só a
 * parcela única, por retrocompatibilidade), e `recorrente_mensal` nasce zerada:
 * um balde sem mensalidade não pode mostrar `null` nem herdar o valor único.
 */
const balde = (moeda: string, bruto: number, ponderado: number, n: number) => ({
  moeda,
  bruto_cents: bruto,
  ponderado_cents: ponderado,
  n,
  unico: { bruto_cents: bruto, ponderado_cents: ponderado },
  recorrente_mensal: { bruto_cents: 0, ponderado_cents: 0 },
});

/** O mesmo balde quando há mensalidade nova na conta. */
const baldeComMensalidade = (
  moeda: string,
  bruto: number,
  ponderado: number,
  n: number,
  mensalBruto: number,
  mensalPonderado: number,
) => ({
  ...balde(moeda, bruto, ponderado, n),
  recorrente_mensal: { bruto_cents: mensalBruto, ponderado_cents: mensalPonderado },
});

/** Todo número da resposta, em qualquer profundidade — para provar que a soma não existe. */
function numeros(valor: unknown, achados: number[] = []): number[] {
  if (typeof valor === "number") achados.push(valor);
  else if (Array.isArray(valor)) for (const item of valor) numeros(item, achados);
  else if (valor && typeof valor === "object") {
    for (const item of Object.values(valor)) numeros(item, achados);
  }
  return achados;
}

/** As etapas do cenário: uma calibrada, uma sem calibração, ganho e perda. */
const ETAPAS: EtapaDaPrevisao[] = [
  etapaDe("qualificada", { win_probability: 50 }),
  etapaDe("proposta", { win_probability: 25 }),
  etapaDe("sem_calibracao"),
  etapaDe("ganho", { is_won: true }),
  etapaDe("perdido", { is_lost: true }),
];

describe("previsao — o critério de aceite de moedas separadas", () => {
  it("R$ 10 mil a 50%, R$ 20 mil a 25% e € 4 mil a 50% → R$ 10 mil + € 2 mil, separados", () => {
    const leads = [
      leadDe("a", {
        stage_id: "qualificada",
        value_cents: 1_000_000,
        expected_close_date: "2026-10-05",
      }),
      leadDe("b", {
        stage_id: "proposta",
        value_cents: 2_000_000,
        expected_close_date: "2026-10-20",
      }),
      leadDe("c", {
        stage_id: "qualificada",
        currency: "EUR",
        value_cents: 400_000,
        expected_close_date: "2026-10-12",
      }),
    ];

    const r = previsao(leads, ETAPAS, { fonte: "etapa" });

    expect(r.totais).toEqual([
      balde("BRL", 3_000_000, 1_000_000, 2),
      balde("EUR", 400_000, 200_000, 1),
    ]);

    // Agrupado por moeda × mês, e a soma dos meses bate com o total da moeda.
    expect(r.meses).toEqual([
      { ...balde("BRL", 3_000_000, 1_000_000, 2), mes: "2026-10" },
      { ...balde("EUR", 400_000, 200_000, 1), mes: "2026-10" },
    ]);
    expect(r.sem_data).toEqual([]);
    expect(r.sem_probabilidade).toEqual([]);
  });

  it("mês diferente na mesma moeda vira duas faixas, não uma só", () => {
    const r = previsao(
      [
        leadDe("a", { value_cents: 100_000, expected_close_date: "2026-11-02" }),
        leadDe("b", { value_cents: 100_000, expected_close_date: "2026-12-31" }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.meses.map((m) => m.mes)).toEqual(["2026-11", "2026-12"]);
    expect(r.meses.map((m) => m.ponderado_cents)).toEqual([50_000, 50_000]);
  });
});

describe("previsao — os baldes que nunca viram zero silencioso", () => {
  it("lead sem data cai em 'sem data', com o valor e o ponderado visíveis", () => {
    const r = previsao(
      [leadDe("a", { value_cents: 100_000, expected_close_date: null })],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.sem_data).toEqual([balde("BRL", 100_000, 50_000, 1)]);
    // Sem mês não há faixa de mês — e o total da moeda continua batendo.
    expect(r.meses).toEqual([]);
    expect(r.totais[0]?.ponderado_cents).toBe(50_000);
  });

  it("lead em etapa sem probabilidade cai em 'sem probabilidade' e NÃO soma no ponderado", () => {
    const r = previsao(
      [
        leadDe("a", {
          stage_id: "sem_calibracao",
          value_cents: 100_000,
          expected_close_date: "2026-10-10",
        }),
        leadDe("b", { value_cents: 900_000, expected_close_date: "2026-10-11" }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.sem_probabilidade).toEqual([balde("BRL", 100_000, 0, 1)]);
    // O que tem calibração segue no total; o que não tem, não entra.
    expect(r.totais).toEqual([balde("BRL", 900_000, 450_000, 1)]);
    expect(r.meses).toEqual([{ ...balde("BRL", 900_000, 450_000, 1), mes: "2026-10" }]);
  });

  it("sem probabilidade E sem data aparece uma vez só — em 'sem probabilidade'", () => {
    const r = previsao(
      [
        leadDe("a", {
          stage_id: "sem_calibracao",
          value_cents: 50_000,
          expected_close_date: null,
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.sem_probabilidade).toHaveLength(1);
    expect(r.sem_data).toEqual([]);
    expect(r.totais).toEqual([]);
  });

  it("negócio fechado não entra: a regra é de abertos", () => {
    const r = previsao(
      [leadDe("a", { status: "won", value_cents: 100_000, expected_close_date: "2026-10-01" })],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.totais).toEqual([]);
    expect(r.meses).toEqual([]);
    expect(r.sem_data).toEqual([]);
    expect(r.sem_probabilidade).toEqual([]);
  });
});

describe("previsao — AS DUAS PARCELAS DO CONTRATO (issue #3602)", () => {
  it("⭐ setup R$ 3.000 a 50% + mensalidade R$ 500/mês a 50% → unico 300.000/150.000 e recorrente_mensal 50.000/25.000, NUNCA 350.000/175.000", () => {
    const r = previsao(
      [
        leadDe("a", {
          stage_id: "qualificada",
          value_cents: 300_000,
          expected_close_date: "2026-11-10",
        }),
        leadDe("b", {
          stage_id: "qualificada",
          value_cents: 0,
          recurring_value_cents: 50_000,
          recurring_period: "monthly",
          expected_close_date: "2026-11-20",
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    const mes = r.meses[0];
    expect(mes?.mes).toBe("2026-11");
    expect(mes?.unico).toEqual({ bruto_cents: 300_000, ponderado_cents: 150_000 });
    expect(mes?.recorrente_mensal).toEqual({ bruto_cents: 50_000, ponderado_cents: 25_000 });
    expect(r.totais[0]?.unico).toEqual({ bruto_cents: 300_000, ponderado_cents: 150_000 });
    expect(r.totais[0]?.recorrente_mensal).toEqual({
      bruto_cents: 50_000,
      ponderado_cents: 25_000,
    });

    // Retrocompatibilidade: os campos planos continuam sendo SÓ a parcela única.
    expect(mes?.bruto_cents).toBe(300_000);
    expect(mes?.ponderado_cents).toBe(150_000);
    expect(mes?.n).toBe(2);

    // A soma das duas parcelas não existe em campo NENHUM da resposta.
    const todosOsNumeros = numeros(r);
    expect(todosOsNumeros).not.toContain(350_000);
    expect(todosOsNumeros).not.toContain(175_000);
  });

  it("mensalidade sem periodicidade declarada nasce MENSAL (regra 2 da fatia 1)", () => {
    const r = previsao(
      [
        leadDe("a", {
          value_cents: 0,
          recurring_value_cents: 40_000,
          expected_close_date: "2026-11-10",
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.meses[0]?.recorrente_mensal).toEqual({
      bruto_cents: 40_000,
      ponderado_cents: 20_000,
    });
  });

  it("recorrência que NÃO é mensal não entra em recorrente_mensal: fica em recorrencia_nao_mensal, com o valor", () => {
    const r = previsao(
      [
        leadDe("a", {
          value_cents: 100_000,
          recurring_value_cents: 120_000,
          recurring_period: "anual",
          expected_close_date: "2026-11-10",
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    // Projetar 120.000/ano como se fosse mensal inventaria um número; somá-lo
    // no único repetiria o defeito da issue. Ele sai à parte, ponderado pela
    // mesma probabilidade do negócio.
    expect(r.meses[0]?.recorrente_mensal).toEqual({ bruto_cents: 0, ponderado_cents: 0 });
    expect(r.meses[0]?.unico).toEqual({ bruto_cents: 100_000, ponderado_cents: 50_000 });
    expect(r.recorrencia_nao_mensal).toEqual([
      { moeda: "BRL", bruto_cents: 120_000, ponderado_cents: 60_000, n: 1 },
    ]);
  });

  it("negócio sem data prevista e com recorrência: a mensalidade aparece no balde 'sem data', não some", () => {
    const r = previsao(
      [
        leadDe("a", {
          value_cents: 0,
          recurring_value_cents: 80_000,
          recurring_period: "monthly",
          expected_close_date: null,
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.meses).toEqual([]);
    expect(r.sem_data).toEqual([baldeComMensalidade("BRL", 0, 0, 1, 80_000, 40_000)]);
    expect(r.totais).toEqual([baldeComMensalidade("BRL", 0, 0, 1, 80_000, 40_000)]);
  });

  it("organização sem recorrência: recorrente_mensal vem ZERADA, nunca null", () => {
    const r = previsao(
      [leadDe("a", { value_cents: 100_000, expected_close_date: "2026-11-10" })],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.totais[0]?.recorrente_mensal).toEqual({ bruto_cents: 0, ponderado_cents: 0 });
    expect(r.meses[0]?.recorrente_mensal).toEqual({ bruto_cents: 0, ponderado_cents: 0 });
    expect(r.sem_data).toEqual([]);
    expect(r.recorrencia_nao_mensal).toEqual([]);
  });

  it("recorrência em etapa sem probabilidade entra com ponderado 0 — visível, não zero silencioso", () => {
    const r = previsao(
      [
        leadDe("a", {
          stage_id: "sem_calibracao",
          value_cents: 0,
          recurring_value_cents: 60_000,
          expected_close_date: "2026-11-10",
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    expect(r.sem_probabilidade).toEqual([baldeComMensalidade("BRL", 0, 0, 1, 60_000, 0)]);
    expect(r.totais).toEqual([]);
    expect(r.meses).toEqual([]);
  });

  it("a duração NÃO multiplica a projeção: mensalidade de um contrato de 12 meses continua sendo a DO MÊS", () => {
    const r = previsao(
      [
        leadDe("a", {
          value_cents: 0,
          recurring_value_cents: 50_000,
          recurring_period: "monthly",
          recurring_months: 12,
          expected_close_date: "2026-11-10",
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    // "Valor do contrato" (único + mensalidade × meses) é outro número, de
    // outro recorte: aqui a previsão é do mês de fechamento.
    expect(r.meses[0]?.recorrente_mensal).toEqual({
      bruto_cents: 50_000,
      ponderado_cents: 25_000,
    });
  });
});

describe("probabilidadeDoLead — a fonte escolhida por funil", () => {
  it("etapa de GANHO vale 100 e etapa de PERDA vale 0, sem nada gravado", () => {
    const ganho = etapaDe("g", { is_won: true, win_probability: null });
    const perdido = etapaDe("p", { is_lost: true, win_probability: null });

    expect(probabilidadeDoLead(leadDe("a"), ganho, "etapa")).toBe(100);
    expect(probabilidadeDoLead(leadDe("a"), perdido, "etapa")).toBe(0);
    expect(probabilidadeDoLead(leadDe("a"), ganho, "ia_quando_houver")).toBe(100);
  });

  it("fonte 'etapa' IGNORA a IA, mesmo com pontuação presente", () => {
    const r = previsao(
      [
        leadDe("a", {
          value_cents: 100_000,
          expected_close_date: "2026-10-01",
          ai_probability: 90,
        }),
      ],
      ETAPAS,
      { fonte: "etapa" },
    );

    // etapa "qualificada" = 50% → 50 mil; os 90 da IA não mandam em nada.
    expect(r.totais[0]?.ponderado_cents).toBe(50_000);
  });

  it("fonte 'ia_quando_houver' usa ai_probability quando existe", () => {
    const r = previsao(
      [
        leadDe("a", {
          value_cents: 100_000,
          expected_close_date: "2026-10-01",
          ai_probability: 80,
        }),
      ],
      ETAPAS,
      { fonte: "ia_quando_houver" },
    );

    expect(r.fonte).toBe("ia_quando_houver");
    expect(r.totais[0]?.ponderado_cents).toBe(80_000);
  });

  it("fonte 'ia_quando_houver' CAI PARA A ETAPA quando a IA não pontuou", () => {
    const r = previsao(
      [
        leadDe("a", {
          stage_id: "proposta",
          value_cents: 100_000,
          expected_close_date: "2026-10-01",
          ai_probability: null,
        }),
      ],
      ETAPAS,
      { fonte: "ia_quando_houver" },
    );

    expect(r.totais[0]?.ponderado_cents).toBe(25_000);
  });

  it("IA e etapa AMBAS sem pontuação → balde 'sem probabilidade', não zero", () => {
    const r = previsao(
      [
        leadDe("a", {
          stage_id: "sem_calibracao",
          value_cents: 100_000,
          expected_close_date: "2026-10-01",
          ai_probability: null,
        }),
      ],
      ETAPAS,
      { fonte: "ia_quando_houver" },
    );

    expect(r.totais).toEqual([]);
    expect(r.sem_probabilidade[0]?.bruto_cents).toBe(100_000);
  });

  it("pontuação da IA fora de 0–100 é aparada, não propagada", () => {
    expect(
      probabilidadeDoLead(leadDe("a", { ai_probability: 400 }), ETAPAS[0], "ia_quando_houver"),
    ).toBe(100);
    expect(
      probabilidadeDoLead(leadDe("a", { ai_probability: -3 }), ETAPAS[0], "ia_quando_houver"),
    ).toBe(0);
    expect(
      probabilidadeDoLead(leadDe("a", { ai_probability: NaN }), ETAPAS[0], "ia_quando_houver"),
    ).toBe(50);
  });

  it("lead sem etapa conhecida → sem probabilidade", () => {
    expect(probabilidadeDoLead(leadDe("a", { stage_id: null }), undefined, "etapa")).toBeNull();
  });
});

describe("fontePrevisao — o que o funil declarou", () => {
  it("sem nada declarado é 'etapa'", () => {
    expect(fontePrevisao(null)).toBe("etapa");
    expect(fontePrevisao({})).toBe("etapa");
    expect(fontePrevisao({ previsao: {} })).toBe("etapa");
  });

  it("declaração válida é respeitada", () => {
    expect(fontePrevisao({ previsao: { fonte: "ia_quando_houver" } })).toBe("ia_quando_houver");
  });

  it("valor torto cai no padrão em vez de derrubar a leitura", () => {
    expect(fontePrevisao({ previsao: { fonte: "qualquer_coisa" } })).toBe("etapa");
    expect(fontePrevisao("lixo")).toBe("etapa");
  });
});
