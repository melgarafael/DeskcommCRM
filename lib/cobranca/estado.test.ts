import { describe, expect, it } from "vitest";

import type { Situacao } from "@/lib/cobranca/provedores/contrato";

import { aplicarLeitura, traduzirSituacao, type AssinaturaAtual } from "./estado";

const AGORA = new Date("2026-10-10T12:00:00Z");
const ANTEONTEM = new Date("2026-10-08T12:00:00Z");
const ONTEM = new Date("2026-10-09T12:00:00Z");
const AMANHA = new Date("2026-10-11T12:00:00Z");
const MES_QUE_VEM = new Date("2026-11-10T12:00:00Z");

function situacao(p: Partial<Situacao> = {}): Situacao {
  return {
    assinaturaRef: null, existe: false, assinaturasVivas: 0, cancelada: false, cancelaNoFim: false,
    emAtraso: false, vencidaDesde: null, proximoVencimento: null, jaPagou: false,
    emTesteNoProvedorAte: null, pagamentoSemAssinaturaViva: false, linkDePagamento: null,
    statusBruto: "teste", ...p,
  };
}

function atual(p: Partial<AssinaturaAtual> = {}): AssinaturaAtual {
  return {
    estado: "trial", planoId: "plano-a", planoAgendadoId: null, trialAte: AMANHA, vencidaDesde: null,
    proximoVencimento: null, provedorAssinaturaId: null, ...p,
  };
}

describe("traduzirSituacao — a tabela de §3.2, em ordem", () => {
  it.each([
    ["cancelada sem cancelar no fim", situacao({ cancelada: true, jaPagou: true }), AMANHA, "cancelada"],
    ["cancelada com cancelaNoFim cai nas linhas seguintes (já pagou → cancelada)", situacao({ cancelada: true, cancelaNoFim: true, jaPagou: true }), AMANHA, "cancelada"],
    ["existe e em atraso", situacao({ existe: true, emAtraso: true, assinaturasVivas: 1 }), ONTEM, "em_atraso"],
    ["existe e em dia", situacao({ existe: true, assinaturasVivas: 1 }), ONTEM, "ativa"],
    ["existe e em dia, com cancelamento no fim do período", situacao({ existe: true, cancelaNoFim: true, assinaturasVivas: 1 }), ONTEM, "ativa"],
    ["não existe e já pagou (cancelou, ou reassinou sem o 1º pagamento)", situacao({ jaPagou: true, assinaturasVivas: 1 }), AMANHA, "cancelada"],
    ["em teste no provedor, mesmo com o teste local vencido", situacao({ emTesteNoProvedorAte: AMANHA, assinaturasVivas: 1 }), ONTEM, "trial"],
    ["teste no provedor já vencido e sem pagamento: vale o teste local", situacao({ emTesteNoProvedorAte: ONTEM }), AMANHA, "trial"],
    ["nunca pagou, dentro do teste local", situacao(), AMANHA, "trial"],
    ["nunca pagou, teste local vencido", situacao(), ONTEM, "em_atraso"],
    ["nunca pagou, sem data de teste (falha fechada)", situacao(), null, "em_atraso"],
    ["⭐ clicou em Assinar e não pagou (incomplete) não reativa", situacao({ assinaturasVivas: 1 }), ONTEM, "em_atraso"],
  ] as const)("%s", (_, s, trialAte, esperado) => {
    expect(traduzirSituacao(s, trialAte, AGORA)).toBe(esperado);
  });
});

describe("aplicarLeitura — a dívida é monotônica", () => {
  it("em atraso pela primeira vez na Stripe: a dívida começa quando a vimos", () => {
    const r = aplicarLeitura(atual({ estado: "ativa" }), situacao({ existe: true, emAtraso: true, assinaturasVivas: 1 }), AGORA);
    expect(r.estado).toBe("em_atraso");
    expect(r.vencidaDesde).toEqual(AGORA);
    expect(r.mudouEstado).toBe(true);
  });

  it("o Asaas sabe a data: vale a data do provedor", () => {
    const r = aplicarLeitura(atual({ estado: "ativa" }), situacao({ existe: true, emAtraso: true, vencidaDesde: ONTEM }), AGORA);
    expect(r.vencidaDesde).toEqual(ONTEM);
  });

  it("⭐ releitura sem data não empurra a dívida para frente", () => {
    const r = aplicarLeitura(atual({ estado: "em_atraso", vencidaDesde: ONTEM }), situacao({ existe: true, emAtraso: true }), AGORA);
    expect(r.vencidaDesde).toEqual(ONTEM);
    expect(r.mudouEstado).toBe(false);
  });

  it("recua quando o provedor informa uma data mais antiga", () => {
    const r = aplicarLeitura(
      atual({ estado: "em_atraso", vencidaDesde: ONTEM }),
      situacao({ existe: true, emAtraso: true, vencidaDesde: ANTEONTEM }),
      AGORA,
    );
    expect(r.vencidaDesde).toEqual(ANTEONTEM);
  });

  it("teste vencido sem pagamento: a dívida começa no fim do teste", () => {
    const r = aplicarLeitura(atual({ trialAte: ONTEM }), situacao(), AGORA);
    expect(r.estado).toBe("em_atraso");
    expect(r.vencidaDesde).toEqual(ONTEM);
  });

  it("⭐ cancelar e reassinar não zera vencida_desde", () => {
    let a = atual({ estado: "em_atraso", vencidaDesde: ONTEM });
    const leituras = [
      situacao({ cancelada: true, jaPagou: true }),
      situacao({ jaPagou: true, assinaturasVivas: 1 }),
      situacao({ existe: true, emAtraso: true, jaPagou: true, assinaturasVivas: 1 }),
    ];
    const estados: string[] = [];
    for (const s of leituras) {
      const r = aplicarLeitura(a, s, AGORA);
      estados.push(r.estado);
      expect(r.vencidaDesde).toEqual(ONTEM);
      a = { ...a, estado: r.estado, vencidaDesde: r.vencidaDesde };
    }
    expect(estados).toEqual(["cancelada", "cancelada", "em_atraso"]);
  });

  it("pagou: volta a ativa, zera a dívida e o aviso da régua", () => {
    const r = aplicarLeitura(atual({ estado: "em_atraso", vencidaDesde: ONTEM }), situacao({ existe: true, assinaturasVivas: 1 }), AGORA);
    expect(r.estado).toBe("ativa");
    expect(r.vencidaDesde).toBeNull();
    expect(r.zerarAviso).toBe(true);
  });

  it("controle: sem transição, o aviso fica (ativa → ativa, trial → trial)", () => {
    expect(aplicarLeitura(atual({ estado: "ativa" }), situacao({ existe: true, assinaturasVivas: 1 }), AGORA).zerarAviso).toBe(false);
    expect(aplicarLeitura(atual({ estado: "trial" }), situacao(), AGORA).zerarAviso).toBe(false);
  });
});

describe("aplicarLeitura — período pago e plano agendado", () => {
  it("⭐ leitura sem próximo vencimento não apaga o período pago", () => {
    const r = aplicarLeitura(atual({ estado: "ativa", proximoVencimento: MES_QUE_VEM }), situacao({ existe: true, assinaturasVivas: 1 }), AGORA);
    expect(r.proximoVencimento).toEqual(MES_QUE_VEM);
  });

  it("o plano agendado vira na virada paga", () => {
    const r = aplicarLeitura(
      atual({ estado: "ativa", planoAgendadoId: "plano-b", proximoVencimento: AMANHA }),
      situacao({ existe: true, assinaturasVivas: 1, proximoVencimento: MES_QUE_VEM }),
      AGORA,
    );
    expect(r.planoId).toBe("plano-b");
    expect(r.planoAgendadoId).toBeNull();
    expect(r.planoAplicado).toBe(true);
    expect(r.descartarAgendado).toBe(false);
  });

  it("⭐ reassinar depois de cancelar descarta o agendado: o checkout cobrou o plano atual", () => {
    const r = aplicarLeitura(
      atual({ estado: "cancelada", planoAgendadoId: "plano-b", proximoVencimento: AMANHA }),
      situacao({ existe: true, assinaturasVivas: 1, proximoVencimento: MES_QUE_VEM }),
      AGORA,
    );
    expect(r.estado).toBe("ativa");
    expect(r.planoId).toBe("plano-a");
    expect(r.planoAgendadoId).toBeNull();
    expect(r.planoAplicado).toBe(false);
    // Quem grava só escreve o plano quando planoAplicado: o descarte precisa de sinal próprio.
    expect(r.descartarAgendado).toBe(true);
  });

  it("⭐ a assinatura que carregava o agendado foi cancelada: ele é descartado já na entrada", () => {
    const r = aplicarLeitura(
      atual({ estado: "ativa", planoAgendadoId: "plano-b", proximoVencimento: AMANHA }),
      situacao({ cancelada: true, jaPagou: true }),
      AGORA,
    );
    expect(r.estado).toBe("cancelada");
    expect(r.planoId).toBe("plano-a");
    expect(r.planoAgendadoId).toBeNull();
    expect(r.planoAplicado).toBe(false);
    expect(r.descartarAgendado).toBe(true);
  });

  it("⭐ reassinar e cair em atraso antes da 1ª releitura em dia: o agendado velho não vira ao pagar", () => {
    const linha = atual({ estado: "cancelada", planoAgendadoId: "plano-b", proximoVencimento: AMANHA });
    const emAtraso = aplicarLeitura(
      linha,
      situacao({ existe: true, emAtraso: true, assinaturasVivas: 1, proximoVencimento: MES_QUE_VEM }),
      AGORA,
    );
    expect(emAtraso.estado).toBe("em_atraso");
    expect(emAtraso.descartarAgendado).toBe(true);
    const pago = aplicarLeitura(
      { ...linha, estado: emAtraso.estado, planoAgendadoId: emAtraso.planoAgendadoId, proximoVencimento: emAtraso.proximoVencimento },
      situacao({ existe: true, assinaturasVivas: 1, proximoVencimento: MES_QUE_VEM }),
      AGORA,
    );
    expect(pago.planoId).toBe("plano-a");
    expect(pago.planoAplicado).toBe(false);
  });

  it("controle: mesmo período (nada pago de novo), o agendado espera", () => {
    const r = aplicarLeitura(
      atual({ estado: "ativa", planoAgendadoId: "plano-b", proximoVencimento: AMANHA }),
      situacao({ existe: true, assinaturasVivas: 1, proximoVencimento: AMANHA }),
      AGORA,
    );
    expect(r.planoId).toBe("plano-a");
    expect(r.planoAgendadoId).toBe("plano-b");
    expect(r.planoAplicado).toBe(false);
    expect(r.descartarAgendado).toBe(false);
  });

  it("período avançou mas em atraso (a Stripe abre o período antes de cobrar): o agendado espera", () => {
    const r = aplicarLeitura(
      atual({ estado: "ativa", planoAgendadoId: "plano-b", proximoVencimento: AMANHA }),
      situacao({ existe: true, emAtraso: true, assinaturasVivas: 1, proximoVencimento: MES_QUE_VEM }),
      AGORA,
    );
    expect(r.planoId).toBe("plano-a");
    expect(r.proximoVencimento).toEqual(MES_QUE_VEM);
  });

  it("⭐ e quando esse atraso é pago, o agendado vira — mesmo sem o período avançar de novo", () => {
    const r = aplicarLeitura(
      atual({ estado: "em_atraso", planoAgendadoId: "plano-b", proximoVencimento: MES_QUE_VEM, vencidaDesde: ONTEM }),
      situacao({ existe: true, assinaturasVivas: 1, proximoVencimento: MES_QUE_VEM }),
      AGORA,
    );
    expect(r.estado).toBe("ativa");
    expect(r.planoId).toBe("plano-b");
    expect(r.planoAplicado).toBe(true);
  });
});

describe("aplicarLeitura — o resto da linha", () => {
  it("assinaturas vivas, releitura, cancelamento no fim e a referência da principal", () => {
    const r = aplicarLeitura(
      atual({ estado: "ativa", provedorAssinaturaId: "sub_velha" }),
      situacao({ existe: true, assinaturasVivas: 2, cancelaNoFim: true, assinaturaRef: "sub_nova" }),
      AGORA,
    );
    expect(r.assinaturasVivas).toBe(2);
    expect(r.relidaEm).toEqual(AGORA);
    expect(r.cancelaNoFim).toBe(true);
    expect(r.provedorAssinaturaId).toBe("sub_nova");
    expect(aplicarLeitura(atual({ provedorAssinaturaId: "sub_velha" }), situacao(), AGORA).provedorAssinaturaId).toBe("sub_velha");
  });

  it("pagamento de assinatura cancelada vira ultimo_erro; leitura limpa zera", () => {
    expect(aplicarLeitura(atual(), situacao({ jaPagou: true, pagamentoSemAssinaturaViva: true }), AGORA).ultimoErro).toBe(
      "pagamento_de_assinatura_cancelada",
    );
    expect(aplicarLeitura(atual(), situacao(), AGORA).ultimoErro).toBeNull();
  });

  it("checkout concluído (há assinatura viva) limpa o link de checkout; sem assinatura viva, mantém", () => {
    expect(aplicarLeitura(atual(), situacao({ assinaturasVivas: 1 }), AGORA).limparCheckout).toBe(true);
    expect(aplicarLeitura(atual(), situacao(), AGORA).limparCheckout).toBe(false);
  });
});
