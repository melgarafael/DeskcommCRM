import { describe, expect, it } from "vitest";

import {
  FILTRO_RADAR_VAZIO,
  agregarRadar,
  classificarNivel,
  filtrarLinhas,
  scoreRecompra,
  type LinhaRadar,
} from "./radar-score";

function linha(parcial: Partial<LinhaRadar> = {}): LinhaRadar {
  return {
    contact_id: "c1",
    nome: "Mercado",
    fone: null,
    cidade: null,
    uf: null,
    vendedor_user_id: null,
    qtd_pedidos: 5,
    ticket_medio_cents: 512000,
    intervalo_mediano_dias: 22.5,
    intervalo_medio_dias: 22,
    dias_sem_compra: 30,
    atraso_dias: 8,
    situacao: "recompra_atrasada",
    ultima_compra: "2026-03-31",
    ultimos: [{ id: "e", dia: "2026-03-31", total_cents: 510000 }],
    ...parcial,
  };
}

describe("classificarNivel", () => {
  it("segue a situação: risco e crítico vêm do comportamento, não de dia fixo", () => {
    expect(classificarNivel({ situacao: "em_risco" })).toBe("critico");
    expect(classificarNivel({ situacao: "recompra_atrasada" })).toBe("risco");
    expect(classificarNivel({ situacao: "em_voo" })).toBe("atencao");
    expect(classificarNivel({ situacao: "oportunidade_aberta" })).toBe("atencao");
    expect(classificarNivel({ situacao: "cancelado_sem_nova" })).toBe("atencao");
    expect(classificarNivel({ situacao: "ok" })).toBe("saudavel");
    expect(classificarNivel({ situacao: "primeira_compra", dias_sem_compra: 30 })).toBe("saudavel");
  });

  it("compra única velha não é saudável — mas nunca risco sem padrão", () => {
    expect(classificarNivel({ situacao: "primeira_compra", dias_sem_compra: 200 })).toBe("atencao");
  });
});

describe("scoreRecompra", () => {
  it("23 dias sem comprar com padrão de 15 pesa mais que 45 com padrão de 60", () => {
    const a = scoreRecompra({
      atraso_dias: 8, dias_sem_compra: 23, ticket_medio_cents: 100000, qtd_pedidos: 5, intervaloTipico: 15,
    });
    const b = scoreRecompra({
      atraso_dias: 0, dias_sem_compra: 45, ticket_medio_cents: 100000, qtd_pedidos: 5, intervaloTipico: 60,
    });
    expect(a).toBeGreaterThan(b);
  });

  it("satura em 100 e zera sem sinal", () => {
    const cheio = scoreRecompra({
      atraso_dias: 200, dias_sem_compra: 400, ticket_medio_cents: 99999999, qtd_pedidos: 99, intervaloTipico: 10,
    });
    expect(cheio).toBe(100);
    const vazio = scoreRecompra({
      atraso_dias: 0, dias_sem_compra: 0, ticket_medio_cents: 0, qtd_pedidos: 0, intervaloTipico: null,
    });
    expect(vazio).toBe(0);
  });
});

describe("agregarRadar", () => {
  it("KPIs, distribuição e ranking saem das linhas", () => {
    const linhas = [
      linha({ contact_id: "a", situacao: "recompra_atrasada", atraso_dias: 8 }),
      linha({ contact_id: "b", situacao: "em_risco", atraso_dias: 40, ticket_medio_cents: 100000 }),
      linha({ contact_id: "c", situacao: "ok", atraso_dias: 0, dias_sem_compra: 5 }),
      linha({ contact_id: "d", situacao: "primeira_compra", atraso_dias: 0, intervalo_mediano_dias: null, intervalo_medio_dias: null }),
      linha({ contact_id: "e", situacao: "primeira_compra", atraso_dias: 0, dias_sem_compra: 200, intervalo_mediano_dias: null, intervalo_medio_dias: null }),
      linha({ contact_id: "f", situacao: "novo_sem_compras", atraso_dias: 0, qtd_pedidos: 0, ticket_medio_cents: 0 }),
    ];
    const r = agregarRadar(linhas, "2026-04-30");
    expect(r.monitorados).toBe(5);
    expect(r.semCompraValida).toBe(1);
    expect(r.emRisco).toBe(2);
    expect(r.riscoPct).toBe(40);
    expect(r.oportunidades).toBe(2);
    expect(r.potencialCents).toBe(612000);
    expect(r.receitaRiscoCents).toBe(612000);
    expect(r.distrib).toEqual({ saudavel: 2, atencao: 1, risco: 1, critico: 1 });
    expect(r.recompra).toEqual({ noPrazo: 1, atrasados: 1, muitoAtrasados: 1, primeiraCompra: 2 });
    expect(r.ranking.map((x) => x.contact_id)).toEqual(["b", "a"]);
    expect(r.serie).toHaveLength(12);
  });
});

describe("filtrarLinhas", () => {
  it("busca, nível, vendedor, cidade, dias e ticket filtram de verdade", () => {
    const linhas = [
      linha({ contact_id: "a", nome: "Mercado Silva", cidade: "Joinville", uf: "SC", vendedor_user_id: "v1", dias_sem_compra: 30, ticket_medio_cents: 500000 }),
      linha({ contact_id: "b", nome: "Padaria Pão", cidade: "Araquari", uf: "SC", vendedor_user_id: "v2", dias_sem_compra: 5, ticket_medio_cents: 10000, situacao: "ok", atraso_dias: 0 }),
    ];
    expect(filtrarLinhas(linhas, { ...FILTRO_RADAR_VAZIO, busca: "silva" }).map((l) => l.contact_id)).toEqual(["a"]);
    expect(filtrarLinhas(linhas, { ...FILTRO_RADAR_VAZIO, niveis: ["saudavel"] }).map((l) => l.contact_id)).toEqual(["b"]);
    expect(filtrarLinhas(linhas, { ...FILTRO_RADAR_VAZIO, vendedor: "v2" }).map((l) => l.contact_id)).toEqual(["b"]);
    expect(filtrarLinhas(linhas, { ...FILTRO_RADAR_VAZIO, cidade: "araq" }).map((l) => l.contact_id)).toEqual(["b"]);
    expect(filtrarLinhas(linhas, { ...FILTRO_RADAR_VAZIO, diasMin: 10 }).map((l) => l.contact_id)).toEqual(["a"]);
    expect(filtrarLinhas(linhas, { ...FILTRO_RADAR_VAZIO, ticketMinCents: 100000 }).map((l) => l.contact_id)).toEqual(["a"]);
    expect(filtrarLinhas(linhas, { ...FILTRO_RADAR_VAZIO, periodoDias: 10 }).map((l) => l.contact_id)).toEqual(["b"]);
  });
});
