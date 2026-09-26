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
      { moeda: "BRL", bruto_cents: 3_000_000, ponderado_cents: 1_000_000, n: 2 },
      { moeda: "EUR", bruto_cents: 400_000, ponderado_cents: 200_000, n: 1 },
    ]);

    // Agrupado por moeda × mês, e a soma dos meses bate com o total da moeda.
    expect(r.meses).toEqual([
      {
        moeda: "BRL",
        mes: "2026-10",
        bruto_cents: 3_000_000,
        ponderado_cents: 1_000_000,
        n: 2,
      },
      {
        moeda: "EUR",
        mes: "2026-10",
        bruto_cents: 400_000,
        ponderado_cents: 200_000,
        n: 1,
      },
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

    expect(r.sem_data).toEqual([
      { moeda: "BRL", bruto_cents: 100_000, ponderado_cents: 50_000, n: 1 },
    ]);
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

    expect(r.sem_probabilidade).toEqual([
      { moeda: "BRL", bruto_cents: 100_000, ponderado_cents: 0, n: 1 },
    ]);
    // O que tem calibração segue no total; o que não tem, não entra.
    expect(r.totais).toEqual([
      { moeda: "BRL", bruto_cents: 900_000, ponderado_cents: 450_000, n: 1 },
    ]);
    expect(r.meses).toEqual([
      {
        moeda: "BRL",
        mes: "2026-10",
        bruto_cents: 900_000,
        ponderado_cents: 450_000,
        n: 1,
      },
    ]);
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
