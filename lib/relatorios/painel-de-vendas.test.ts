import { describe, expect, it } from "vitest";

import { janelaDoRelatorio } from "./janela";
import {
  DIAS_DA_SERIE_DIARIA,
  chavesDaSerie,
  diasDaJanela,
  montarPainelDeVendas,
  type NegocioDoPainel,
} from "./painel-de-vendas";

const TZ = "America/Sao_Paulo";
const NOVEMBRO = janelaDoRelatorio("2026-11-01", "2026-11-19", TZ);

function ganho(closed_at: string, value_cents: number | null, currency = "BRL"): NegocioDoPainel {
  return { status: "won", closed_at, value_cents, currency };
}
function perdido(closed_at: string): NegocioDoPainel {
  return { status: "lost", closed_at, value_cents: 5_000, currency: "BRL" };
}

function montar(negocios: NegocioDoPainel[], janela = NOVEMBRO) {
  return montarPainelDeVendas({ negocios, janela, moedaDaOrganizacao: "BRL" });
}

describe("montarPainelDeVendas — os cartões", () => {
  it("vendas, valor vendido, ticket médio e conversão, com as réguas declaradas", () => {
    const painel = montar([
      ganho("2026-11-03T15:00:00Z", 30_000),
      ganho("2026-11-05T15:00:00Z", 10_000),
      ganho("2026-11-05T18:00:00Z", null), // sem valor
      perdido("2026-11-07T15:00:00Z"),
    ]);

    expect(painel.vendas).toBe(3);
    expect(painel.vendido_centavos).toBe(40_000);
    expect(painel.vendas_com_valor).toBe(2);
    expect(painel.vendas_sem_valor).toBe(1);
    // A venda sem valor NÃO puxa a média para baixo como se fosse de graça.
    expect(painel.ticket_medio_centavos).toBe(20_000);
    expect(painel.perdidos).toBe(1);
    expect(painel.conversao).toBeCloseTo(3 / 4);
  });

  it("período sem nada fechado: conversão e ticket são null, nunca 0", () => {
    const painel = montar([]);

    expect(painel.vendas).toBe(0);
    expect(painel.conversao).toBeNull();
    expect(painel.ticket_medio_centavos).toBeNull();
  });

  it("venda em outra moeda conta como venda, mas fica fora da soma — e é declarada", () => {
    const painel = montar([ganho("2026-11-03T15:00:00Z", 10_000), ganho("2026-11-03T16:00:00Z", 99_999, "USD")]);

    expect(painel.vendas).toBe(2);
    expect(painel.vendido_centavos).toBe(10_000);
    expect(painel.excluidos.outra_moeda).toBe(1);
  });

  it("negócio fora da janela, sem data ou em outro status não entra", () => {
    const painel = montar([
      ganho("2026-10-31T15:00:00Z", 10_000), // antes
      ganho("2026-11-20T03:00:00Z", 10_000), // 00h de 20/11 em SP: fora (janela semiaberta)
      { status: "won", closed_at: null, value_cents: 10_000, currency: "BRL" },
      { status: "open", closed_at: "2026-11-05T15:00:00Z", value_cents: 10_000, currency: "BRL" },
    ]);

    expect(painel.vendas).toBe(0);
    expect(painel.perdidos).toBe(0);
  });
});

describe("montarPainelDeVendas — a série", () => {
  it("um ponto por dia, com zero nos dias sem venda, no fuso da organização", () => {
    const painel = montar([
      // 02h UTC de 04/11 = 23h de 03/11 em São Paulo: conta no DIA 3.
      ganho("2026-11-04T02:00:00Z", 7_000),
      ganho("2026-11-05T15:00:00Z", 3_000),
    ]);

    expect(painel.granularidade).toBe("dia");
    expect(painel.serie).toHaveLength(19);
    expect(painel.serie[0]).toEqual({ chave: "2026-11-01", vendas: 0, centavos: 0 });
    expect(painel.serie.find((p) => p.chave === "2026-11-03")).toEqual({ chave: "2026-11-03", vendas: 1, centavos: 7_000 });
    expect(painel.serie.find((p) => p.chave === "2026-11-04")).toEqual({ chave: "2026-11-04", vendas: 0, centavos: 0 });
    // A soma da série é o cartão: os dois nunca divergem.
    expect(painel.serie.reduce((s, p) => s + p.centavos, 0)).toBe(painel.vendido_centavos);
  });

  it("janela longa vira série MENSAL", () => {
    const ano = janelaDoRelatorio("2026-01-01", "2026-11-19", TZ);
    const painel = montar([ganho("2026-03-10T15:00:00Z", 5_000)], ano);

    expect(painel.granularidade).toBe("mes");
    expect(painel.serie.map((p) => p.chave)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11",
    ]);
    expect(painel.serie[2]).toEqual({ chave: "2026-03", vendas: 1, centavos: 5_000 });
  });

  it("o corte entre série diária e mensal é o declarado", () => {
    expect(diasDaJanela("2026-01-01", "2026-03-03")).toBe(DIAS_DA_SERIE_DIARIA);
    expect(chavesDaSerie("2026-10-30", "2026-11-02", "dia")).toEqual([
      "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02",
    ]);
  });
});
