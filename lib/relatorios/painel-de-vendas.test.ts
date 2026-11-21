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

describe("montarPainelDeVendas — o recorte por funil e tag", () => {
  const FUNIL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const FUNIL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const negocios: NegocioDoPainel[] = [
    { ...ganho("2026-11-03T15:00:00Z", 30_000), pipeline_id: FUNIL_A, tags: ["Atacado"] },
    { ...ganho("2026-11-04T15:00:00Z", 10_000), pipeline_id: FUNIL_A, tags: ["varejo"] },
    { ...ganho("2026-11-05T15:00:00Z", 50_000), pipeline_id: FUNIL_B, tags: [" atacado "] },
    { ...perdido("2026-11-06T15:00:00Z"), pipeline_id: FUNIL_A, tags: ["atacado"] },
    { ...perdido("2026-11-07T15:00:00Z"), pipeline_id: FUNIL_B, tags: ["varejo"] },
  ];

  it("por tag (normalizada): cartões, série e conversão só do recorte", () => {
    const painel = montarPainelDeVendas({
      negocios,
      janela: NOVEMBRO,
      moedaDaOrganizacao: "BRL",
      filtro: { pipeline_id: null, tag: "atacado" },
    });

    // "Atacado" e " atacado " são a mesma tag, como na lista de vendas.
    expect(painel.vendas).toBe(2);
    expect(painel.vendido_centavos).toBe(80_000);
    // O perdido de atacado entra; o de varejo, não: a conversão é a do recorte.
    expect(painel.perdidos).toBe(1);
    expect(painel.conversao).toBeCloseTo(2 / 3);
    expect(painel.serie.reduce((s, p) => s + p.centavos, 0)).toBe(80_000);
  });

  it("por funil e tag juntos", () => {
    const painel = montarPainelDeVendas({
      negocios,
      janela: NOVEMBRO,
      moedaDaOrganizacao: "BRL",
      filtro: { pipeline_id: FUNIL_A, tag: "atacado" },
    });

    expect(painel.vendas).toBe(1);
    expect(painel.vendido_centavos).toBe(30_000);
    expect(painel.perdidos).toBe(1);
  });

  it("sem recorte, conta tudo", () => {
    const painel = montarPainelDeVendas({ negocios, janela: NOVEMBRO, moedaDaOrganizacao: "BRL" });

    expect(painel.vendas).toBe(3);
    expect(painel.perdidos).toBe(2);
  });
});

describe("montarPainelDeVendas — vendas registradas", () => {
  const ATE_DIA_20 = janelaDoRelatorio("2026-11-01", "2026-11-20", TZ);
  const LEAD_ABERTO = "aaaaaaaa-0000-4000-8000-000000000001";
  const LEAD_GANHO_COM_VENDA = "aaaaaaaa-0000-4000-8000-000000000002";
  const LEAD_GANHO_SEM_VENDA = "aaaaaaaa-0000-4000-8000-000000000003";
  const FUNIL = "ffffffff-0000-4000-8000-000000000001";

  const negocios: NegocioDoPainel[] = [
    // ganho COM venda registrada (de qualquer data): não conta pelo ganho
    { id: LEAD_GANHO_COM_VENDA, status: "won", closed_at: "2026-11-10T15:00:00Z", value_cents: 99_999, currency: "BRL", pipeline_id: FUNIL, tags: [] },
    // ganho SEM venda registrada: conta pelo valor do card
    { id: LEAD_GANHO_SEM_VENDA, status: "won", closed_at: "2026-11-11T15:00:00Z", value_cents: 5_000, currency: "BRL", pipeline_id: FUNIL, tags: ["varejo"], contact_id: "c2" },
    { id: "perdido", status: "lost", closed_at: "2026-11-12T15:00:00Z", value_cents: 1_000, currency: "BRL", pipeline_id: FUNIL, tags: [] },
  ];
  const negociosDasVendas = new Map([
    [LEAD_ABERTO, { pipeline_id: FUNIL, tags: ["Atacado"], title: "Dãm Dãm Baby", contact_id: "c1" }],
    [LEAD_GANHO_COM_VENDA, { pipeline_id: FUNIL, tags: [], title: "Ganho", contact_id: "c3" }],
  ]);
  const vendasRegistradas = [
    // card ABERTO, em qualquer etapa: conta
    { id: "r1", lead_id: LEAD_ABERTO, contact_id: "c1", valor_cents: 18_000, currency: "BRL", data: "2026-11-20", tags: [] },
    // recompra no mesmo negócio
    { id: "r2", lead_id: LEAD_ABERTO, contact_id: "c1", valor_cents: 12_000, currency: "BRL", data: "2026-11-15", tags: ["recompra"] },
    { id: "r3", lead_id: LEAD_GANHO_COM_VENDA, contact_id: "c3", valor_cents: 7_000, currency: "BRL", data: "2026-11-10", tags: [] },
    // fora da janela
    { id: "r4", lead_id: LEAD_ABERTO, contact_id: "c1", valor_cents: 50_000, currency: "BRL", data: "2026-10-31", tags: [] },
  ];

  function painel(filtro?: { pipeline_id: string | null; tag: string | null }) {
    return montarPainelDeVendas({
      negocios,
      janela: ATE_DIA_20,
      moedaDaOrganizacao: "BRL",
      filtro,
      vendasRegistradas,
      negociosDasVendas,
      negociosComVendaRegistrada: new Set([LEAD_ABERTO, LEAD_GANHO_COM_VENDA]),
    });
  }

  it("venda registrada conta em qualquer etapa; recompra conta duas vezes; ganho com venda não conta em dobro", () => {
    const p = painel();

    // r1 + r2 + r3 registradas + o ganho sem registro; r4 está fora da janela
    expect(p.vendas).toBe(4);
    expect(p.vendido_centavos).toBe(18_000 + 12_000 + 7_000 + 5_000);
    expect(p.origens).toEqual({ registradas: 3, ganhos_sem_registro: 1 });
    // o valor do card ganho que TEM venda registrada (99.999) não entra
    expect(p.lista.some((v) => v.centavos === 99_999)).toBe(false);
  });

  it("a conversão é dos NEGÓCIOS fechados, e não muda com as vendas registradas", () => {
    const p = painel();

    expect(p.negocios_ganhos).toBe(2);
    expect(p.perdidos).toBe(1);
    expect(p.conversao).toBeCloseTo(2 / 3);
  });

  it("as tags da venda somam as do negócio: venda sem tag num negócio 'Atacado' é de atacado", () => {
    const p = painel({ pipeline_id: null, tag: "atacado" });

    expect(p.vendas).toBe(2);
    expect(p.vendido_centavos).toBe(30_000);
    expect(p.lista.map((v) => v.id)).toEqual(["r1", "r2"]);
  });

  it("a série, os rankings e a lista saem da mesma lista de vendas", () => {
    const p = painel();

    expect(p.serie.find((s) => s.chave === "2026-11-20")).toEqual({ chave: "2026-11-20", vendas: 1, centavos: 18_000 });
    expect(p.serie.reduce((s, x) => s + x.centavos, 0)).toBe(p.vendido_centavos);
    expect(p.rankings.clientes[0]).toEqual({ chave: "c1", centavos: 30_000, vendas: 2 });
    expect(p.rankings.funis[0]).toEqual({ chave: FUNIL, centavos: 42_000, vendas: 4 });
    expect(p.lista[0]!.id).toBe("r1");
    expect(p.opcoes.tags).toEqual(["atacado", "recompra", "varejo"]);
  });
});
