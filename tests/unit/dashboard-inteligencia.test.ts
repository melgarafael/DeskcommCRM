/**
 * A MATEMÁTICA DO SALES INTELLIGENCE É MEDIDA AQUI.
 *
 * Checklist do padrão: diárias, acumulado, meta acumulada, projeção
 * (base/histórica/fallback/sem dados), dias restantes, comparação no mesmo
 * dia, ranking, canais, vendedores, timezone na fronteira, meses de 28/29/30
 * e 31 dias, primeiro/último dia, mês vazio, rascunho e cancelado fora.
 */
import { describe, expect, it } from "vitest";

import {
  acumulado,
  alertasComerciais,
  comparacaoMesAnterior,
  diasNoMes,
  diaNoFuso,
  limitesUtcDoDia,
  metaAcumulada,
  serieDiariaDoMes,
  totaisDoMes,
  vendasPorCanal,
  vendasPorVendedor,
  type PedidoIntel,
} from "@/lib/comercial/inteligencia";
import { projetarVendas } from "@/lib/comercial/projecao";

const FUSO = "America/Sao_Paulo";

function pedido(parcial: Partial<PedidoIntel> & { created_at: string }): PedidoIntel {
  return {
    id: `p-${parcial.created_at}-${Math.random().toString(36).slice(2, 8)}`,
    total_cents: 10000,
    status: "faturado",
    origem: "vendedor",
    vendedor_user_id: "v1",
    contact_id: "c1",
    ...parcial,
  };
}

describe("fuso horário", () => {
  it("meia-noite cai no dia certo em SP", () => {
    // 02:30 UTC = 23:30 do dia anterior em SP.
    expect(diaNoFuso("2026-09-06T02:30:00.000Z", FUSO)).toBe("2026-09-05");
    expect(diaNoFuso("2026-09-06T03:30:00.000Z", FUSO)).toBe("2026-09-06");
  });

  it("fuso inválido não explode", () => {
    expect(diaNoFuso("2026-09-06T12:00:00.000Z", "Narnia/Inexistente")).toBe("2026-09-06");
  });

  it("limites UTC do dia em SP cobrem 03:00Z–02:59Z", () => {
    const { inicio, fim } = limitesUtcDoDia("2026-09-05", FUSO);
    expect(inicio).toBe("2026-09-05T03:00:00.000Z");
    expect(fim).toBe("2026-09-06T03:00:00.000Z");
  });
});

describe("meses", () => {
  it("28/29/30/31 dias", () => {
    expect(diasNoMes("2026-02")).toBe(28);
    expect(diasNoMes("2024-02")).toBe(29);
    expect(diasNoMes("2026-04")).toBe(30);
    expect(diasNoMes("2026-01")).toBe(31);
  });

  it("série cobre todos os dias, com zero onde não vendeu", () => {
    const serie = serieDiariaDoMes([pedido({ created_at: "2026-02-01T12:00:00Z" })], "2026-02", FUSO);
    expect(serie).toHaveLength(28);
    expect(serie[0]?.total_cents).toBe(10000);
    expect(serie[1]?.total_cents).toBe(0);
  });
});

describe("o que conta como venda", () => {
  const base = [
    pedido({ created_at: "2026-09-05T12:00:00Z", status: "rascunho" }),
    pedido({ created_at: "2026-09-05T12:00:00Z", status: "cancelado" }),
    pedido({ created_at: "2026-09-05T12:00:00Z", status: "em_analise" }),
    pedido({ created_at: "2026-09-05T12:00:00Z", status: "faturado" }),
  ];
  it("rascunho e cancelado ficam de fora", () => {
    expect(totaisDoMes(base, "2026-09", FUSO).qtd).toBe(2);
  });
});

describe("acumulado e meta", () => {
  it("acumulado soma dia a dia", () => {
    const serie = serieDiariaDoMes(
      [
        pedido({ created_at: "2026-09-01T12:00:00Z", total_cents: 10000 }),
        pedido({ created_at: "2026-09-03T12:00:00Z", total_cents: 20000 }),
      ],
      "2026-09",
      FUSO,
    );
    const acum = acumulado(serie);
    expect(acum[0]).toBe(10000);
    expect(acum[1]).toBe(10000);
    expect(acum[2]).toBe(30000);
    expect(acum[29]).toBe(30000);
  });

  it("meta acumulada é linear e fecha no total", () => {
    const meta = metaAcumulada(300000, 30);
    expect(meta).toHaveLength(30);
    expect(meta[29]).toBe(300000);
    expect(meta[9]).toBe(100000);
  });
});

describe("comparação honesta", () => {
  it("dia 10 compara com 01–10 do anterior, não com o mês cheio", () => {
    const pedidos = [
      pedido({ created_at: "2026-09-05T12:00:00Z", total_cents: 10000 }),
      pedido({ created_at: "2026-08-05T12:00:00Z", total_cents: 20000 }),
      pedido({ created_at: "2026-08-25T12:00:00Z", total_cents: 90000 }),
    ];
    const c = comparacaoMesAnterior(pedidos, "2026-09", "2026-09-10", FUSO);
    expect(c.atual_cents).toBe(10000);
    expect(c.anterior_cents).toBe(20000);
    expect(c.variacao_pct).toBe(-50);
  });

  it("sem base anterior, variação é nula", () => {
    const c = comparacaoMesAnterior([pedido({ created_at: "2026-09-05T12:00:00Z" })], "2026-09", "2026-09-10", FUSO);
    expect(c.variacao_pct).toBeNull();
  });
});

describe("canais e vendedores", () => {
  const pedidos = [
    pedido({ created_at: "2026-09-05T12:00:00Z", origem: "ia", vendedor_user_id: "v1", contact_id: "c1" }),
    pedido({ created_at: "2026-09-06T12:00:00Z", origem: "whatsapp", vendedor_user_id: "v2", contact_id: "c2" }),
    pedido({ created_at: "2026-09-07T12:00:00Z", origem: "portal_novo", vendedor_user_id: "v1", contact_id: "c1" }),
  ];
  it("origem desconhecida vira outros, com ticket e clientes", () => {
    const canais = vendasPorCanal(pedidos, "2026-09", FUSO);
    expect(canais.map((c) => c.canal).sort()).toEqual(["ia", "outros", "whatsapp"]);
    expect(canais[0]?.ticket_medio_cents).toBe(10000);
  });

  it("ranking ordena por total, com série diária alinhada", () => {
    const ranking = vendasPorVendedor(pedidos, "2026-09", FUSO);
    expect(ranking[0]?.vendedorId).toBe("v1");
    expect(ranking[0]?.total_cents).toBe(20000);
    expect(ranking[0]?.porDia).toHaveLength(30);
    expect(ranking[0]?.clientes).toBe(1);
  });

  it("sem vendedor vira sem_vendedor, não some", () => {
    const ranking = vendasPorVendedor(
      [pedido({ created_at: "2026-09-05T12:00:00Z", vendedor_user_id: null })],
      "2026-09",
      FUSO,
    );
    expect(ranking[0]?.vendedorId).toBe("sem_vendedor");
  });
});

describe("projeção", () => {
  it("ritmo: acumulado + média × restantes", () => {
    const r = projetarVendas({
      acumuladoCents: 100000,
      diasTranscorridos: 10,
      diasNoMes: 30,
      diasRestantesDow: new Array(20).fill(1),
      historicoDiario: [],
      historicoDow: [],
    });
    expect(r.metodo).toBe("ritmo");
    expect(r.mediaDiariaCents).toBe(10000);
    expect(r.projetadoCents).toBe(300000);
    expect(r.faixa).toBeNull();
  });

  it("sem dados não inventa", () => {
    const r = projetarVendas({
      acumuladoCents: 0,
      diasTranscorridos: 5,
      diasNoMes: 30,
      diasRestantesDow: [1, 2, 3],
      historicoDiario: [],
      historicoDow: [],
    });
    expect(r.metodo).toBe("sem_dados");
    expect(r.projetadoCents).toBe(0);
  });

  it("histórico pondera o dia da semana e dá faixa", () => {    // 90 dias: sextas (5) vendem o dobro.
    const hist: number[] = [];
    const dow: number[] = [];
    for (let i = 0; i < 90; i++) {
      const d = i % 7;
      dow.push(d);
      hist.push(d === 5 ? 20000 : 10000);
    }
    const r = projetarVendas({
      acumuladoCents: 100000,
      diasTranscorridos: 10,
      diasNoMes: 30,
      diasRestantesDow: [5, 2],
      historicoDiario: hist,
      historicoDow: dow,
    });
    expect(r.metodo).toBe("historico");
    // sexta esperada (20000) + terça (10000) sobre 100000.
    expect(r.projetadoCents).toBe(130000);
    expect(r.restantePorDia).toEqual([20000, 10000]);
    expect(r.faixa?.[0]).toBeLessThan(r.projetadoCents);
    expect(r.faixa?.[1]).toBeGreaterThan(r.projetadoCents);
  });

  it("histórico curto cai no ritmo", () => {
    const r = projetarVendas({
      acumuladoCents: 50000,
      diasTranscorridos: 5,
      diasNoMes: 30,
      diasRestantesDow: new Array(25).fill(1),
      historicoDiario: new Array(20).fill(10000),
      historicoDow: new Array(20).fill(1),
    });
    expect(r.metodo).toBe("ritmo");
  });

  it("último dia sem restantes projeta o realizado", () => {
    const r = projetarVendas({
      acumuladoCents: 300000,
      diasTranscorridos: 30,
      diasNoMes: 30,
      diasRestantesDow: [],
      historicoDiario: [],
      historicoDow: [],
    });
    expect(r.projetadoCents).toBe(300000);
  });
});

describe("alertas derivados", () => {
  it("projeção abaixo da meta é risco; acima é ok", () => {
    const base = {
      projetadoCents: 200000,
      ritmoDiario: 10000,
      ritmoNecessario: null,
      crescimentoCanais: [],
      ritmoVendedores: [],
      ultimosDias: [10000, 10000, 10000, 10000, 10000],
    };
    expect(
      alertasComerciais({ ...base, metaCents: 300000 })[0]?.tipo,
    ).toBe("risco");
    expect(
      alertasComerciais({ ...base, metaCents: 300000, projetadoCents: 310000 })[0]?.tipo,
    ).toBe("ok");
  });

  it("sem meta não há veredito sobre meta", () => {
    const a = alertasComerciais({
      metaCents: null,
      projetadoCents: 200000,
      ritmoDiario: 10000,
      ritmoNecessario: null,
      crescimentoCanais: [],
      ritmoVendedores: [],
      ultimosDias: [10000, 10000, 10000, 10000, 10000],
    });
    expect(a).toEqual([]);
  });

  it("canal com +20% aparece; vendedor lento aparece", () => {
    const a = alertasComerciais({
      metaCents: null,
      projetadoCents: null,
      ritmoDiario: 0,
      ritmoNecessario: null,
      crescimentoCanais: [{ canal: "WhatsApp", variacao_pct: 24 }],
      ritmoVendedores: [{ nome: "Paulo", abaixoDoRitmo: true }],
      ultimosDias: [10000, 10000, 10000, 10000, 10000],
    });
    expect(a.map((x) => x.texto)).toEqual([
      "WhatsApp cresceu 24%",
      "Paulo abaixo do ritmo esperado",
    ]);
  });
});
