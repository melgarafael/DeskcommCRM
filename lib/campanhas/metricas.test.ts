import { describe, expect, it } from "vitest";

import { progresso, taxasDaCampanha, type ContagemDaCampanha } from "./metricas";

const ZERO: ContagemDaCampanha = {
  total: 0,
  elegiveis: 0,
  excluidos: 0,
  pendentes: 0,
  naFila: 0,
  enviando: 0,
  enviados: 0,
  entregues: 0,
  lidos: 0,
  responderam: 0,
  falharam: 0,
  cancelados: 0,
  optOut: 0,
};

describe("taxas da campanha", () => {
  it("sem denominador a taxa é nula, não zero — 0% e 'ainda não dá para saber' são coisas diferentes", () => {
    expect(taxasDaCampanha(ZERO)).toEqual({
      entrega: null,
      leitura: null,
      resposta: null,
      falha: null,
      optOut: null,
    });
  });

  it("quem respondeu continua contando como entregue e lido (o funil é por carimbo)", () => {
    // 100 enviados, 90 entregues, 60 lidos, 20 responderam. Se o denominador da
    // entrega fosse 'status', os 20 que responderam sairiam da conta e a entrega
    // cairia justamente porque a campanha foi bem.
    const c: ContagemDaCampanha = {
      ...ZERO,
      total: 120,
      elegiveis: 100,
      excluidos: 20,
      enviados: 100,
      entregues: 90,
      lidos: 60,
      responderam: 20,
    };
    const t = taxasDaCampanha(c);
    expect(t.entrega).toBeCloseTo(0.9);
    expect(t.leitura).toBeCloseTo(60 / 90);
    expect(t.resposta).toBeCloseTo(0.2);
  });

  it("o excluído fica fora do denominador — lista suja não vira 'baixa entrega'", () => {
    const c: ContagemDaCampanha = { ...ZERO, total: 200, elegiveis: 100, excluidos: 100, enviados: 100, entregues: 100 };
    expect(taxasDaCampanha(c).entrega).toBe(1);
  });

  it("a taxa de falha usa o TENTADO (saiu ou falhou), não o snapshot", () => {
    const c: ContagemDaCampanha = { ...ZERO, elegiveis: 100, enviados: 80, falharam: 20, pendentes: 0 };
    expect(taxasDaCampanha(c).falha).toBeCloseTo(0.2);
  });
});

describe("progresso", () => {
  it("mede contra o ELEGÍVEL: o excluído nunca vai andar e travaria a barra", () => {
    const c: ContagemDaCampanha = { ...ZERO, total: 150, elegiveis: 100, excluidos: 50, pendentes: 25, enviados: 75 };
    expect(progresso(c)).toBeCloseTo(0.75);
  });

  it("campanha PREPARADA sem ninguém elegível está concluída, não travada em zero", () => {
    expect(progresso({ ...ZERO, total: 10, elegiveis: 0, excluidos: 10 })).toBe(1);
  });

  it("lista ainda não montada é 0%, nunca 100% — medido na tela, no rascunho recém-criado", () => {
    // O rascunho mostrava "Progresso 100%" antes de existir um destinatário
    // sequer, e a leitura errada é "já acabou" em quem nunca começou.
    expect(progresso({ ...ZERO })).toBe(0);
    expect(progresso({ ...ZERO, total: 0, elegiveis: 0 })).toBe(0);
  });

  it("campanha cancelada sem envio é 0%, nunca 100% — medido na tela", () => {
    // Cancelar esvazia a fila, e a conta ingênua de "quantos saíram da fila"
    // lia isso como "terminou". Quem foi cancelado não andou: saiu.
    const c: ContagemDaCampanha = { ...ZERO, total: 5, elegiveis: 5, cancelados: 5 };
    expect(progresso(c)).toBe(0);
    // E a campanha que enviou metade antes de ser cancelada mostra a metade.
    expect(progresso({ ...ZERO, total: 4, elegiveis: 4, enviados: 2, cancelados: 2 })).toBeCloseTo(0.5);
  });

  it("nunca passa de 1 nem cai abaixo de 0, mesmo com contador fora de sincronia", () => {
    expect(progresso({ ...ZERO, total: 10, elegiveis: 10, pendentes: 30 })).toBe(0);
    expect(progresso({ ...ZERO, total: 10, elegiveis: 10 })).toBe(1);
  });
});
