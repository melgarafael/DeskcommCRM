import { describe, expect, it } from "vitest";

import { decidirRegua, type AssinaturaNaRegua, type OrgNaRegua } from "./regua";

/**
 * A RÉGUA (spec da cobrança do revendedor §3.2, §12): cada garantia da spec é
 * um caso. `agora` é fixo; as horas são corridas, nunca dias de calendário.
 */
const AGORA = new Date("2026-10-10T12:00:00Z");
const HORA = 3_600_000;
const ha = (horas: number) => new Date(AGORA.getTime() - horas * HORA);
const em = (horas: number) => new Date(AGORA.getTime() + horas * HORA);

const ATIVA: OrgNaRegua = { status: "active", suspendedKind: null };
const SUSPENSA_POR_COBRANCA: OrgNaRegua = { status: "suspended", suspendedKind: "cobranca" };
const SUSPENSA_ADMINISTRATIVA: OrgNaRegua = { status: "suspended", suspendedKind: "administrativa" };
const REDIGIDA: OrgNaRegua = { status: "redacted", suspendedKind: "cobranca" };

function a(p: Partial<AssinaturaNaRegua> = {}): AssinaturaNaRegua {
  return {
    estado: "ativa", temProvedor: true, cancelaNoFim: false, assinaturasVivas: 1, trialAte: null,
    vencidaDesde: null, proximoVencimento: null, prazoExtraAte: null, ultimoAviso: null, ultimoAvisoEm: null,
    relidaEm: ha(0.25), entradaPendente: false, ...p,
  };
}
const decidir = (x: AssinaturaNaRegua, org: OrgNaRegua = ATIVA, tolerancia = 7) => decidirRegua(x, org, AGORA, tolerancia);

/** Em atraso há `dias`, com o aviso final dado há `horas` (tolerância 7 → limite em `7 - dias` dias). */
const comAvisoFinal = (dias: number, horas: number, p: Partial<AssinaturaNaRegua> = {}) =>
  a({ estado: "em_atraso", vencidaDesde: ha(dias * 24), ultimoAviso: "suspende_em_breve", ultimoAvisoEm: ha(horas), ...p });

describe("sem dívida", () => {
  it("em dia, org ativa: nada (boleto aberto dentro da validade chega aqui como 'ativa')", () => {
    expect(decidir(a()).acao).toEqual({ tipo: "nada" });
  });

  it("teste grátis a 2 dias do fim, sem assinatura: avisa trial_acabando com a data do fim", () => {
    const d = decidir(a({ estado: "trial", temProvedor: false, assinaturasVivas: 0, trialAte: em(48), relidaEm: null }));
    expect(d.acao).toEqual({ tipo: "avisar", aviso: "trial_acabando", debitoDesde: null, data: em(48), origem: "teste" });
  });

  it("teste grátis com a 1ª cobrança já agendada no provedor não recebe trial_acabando", () => {
    expect(decidir(a({ estado: "trial", trialAte: em(48), assinaturasVivas: 1 })).acao).toEqual({ tipo: "nada" });
  });

  it("cancelada com o período pago ainda em curso: nada", () => {
    expect(decidir(a({ estado: "cancelada", proximoVencimento: em(24 * 10) })).acao).toEqual({ tipo: "nada" });
  });
});

describe("a dívida e os avisos", () => {
  it("⭐ teste vencido sem provedor vira em_atraso desde o fim do teste, e o aviso final sai na hora (sem tolerância)", () => {
    const d = decidir(a({ estado: "trial", temProvedor: false, assinaturasVivas: 0, trialAte: ha(24), relidaEm: null }));
    expect(d.estado).toBe("em_atraso");
    expect(d.gravarVencidaDesde).toEqual(ha(24));
    expect(d.acao).toEqual({ tipo: "avisar", aviso: "suspende_em_breve", debitoDesde: ha(24), data: em(48), origem: "teste" });
  });

  it("em atraso há 1 dia, sem aviso: 'venceu', com a data da dívida", () => {
    expect(decidir(a({ estado: "em_atraso", vencidaDesde: ha(24) })).acao).toEqual({
      tipo: "avisar", aviso: "venceu", debitoDesde: ha(24), data: ha(24), origem: "atraso",
    });
  });

  it("a 2 dias do limite: aviso final, com a data da suspensão nunca antes de 48 h", () => {
    const d = decidir(a({ estado: "em_atraso", vencidaDesde: ha(24 * 6), ultimoAviso: "venceu", ultimoAvisoEm: ha(24 * 5) }));
    expect(d.acao).toEqual({ tipo: "avisar", aviso: "suspende_em_breve", debitoDesde: ha(24 * 6), data: em(48), origem: "atraso" });
  });

  it("em atraso sem vencida_desde (linha antiga): grava agora como início da dívida", () => {
    expect(decidir(a({ estado: "em_atraso" })).gravarVencidaDesde).toEqual(AGORA);
  });

  it("cancelada com o período pago já vencido: aviso final direto (sem tolerância)", () => {
    expect(decidir(a({ estado: "cancelada", proximoVencimento: ha(1) })).acao).toEqual({
      tipo: "avisar", aviso: "suspende_em_breve", debitoDesde: ha(1), data: em(48), origem: "cancelamento",
    });
  });

  it("cancelada sem período conhecido: a dívida começa agora e fica gravada", () => {
    const d = decidir(a({ estado: "cancelada" }));
    expect(d.gravarVencidaDesde).toEqual(AGORA);
    expect(d.acao).toMatchObject({ tipo: "avisar", aviso: "suspende_em_breve", origem: "cancelamento" });
  });
});

describe("a suspensão", () => {
  it("⭐ limite passado e aviso final há 49 h: suspende", () => {
    expect(decidir(comAvisoFinal(8, 49)).acao).toEqual({ tipo: "suspender", debitoDesde: ha(24 * 8), origem: "atraso" });
  });

  it("⭐ 47 h 59 min depois do aviso final não suspende (48 h corridas, não dias de calendário)", () => {
    expect(decidir(comAvisoFinal(8, 47 + 59 / 60)).acao).toEqual({ tipo: "nada" });
  });

  it("releitura com mais de 1 h bloqueia a suspensão", () => {
    expect(decidir(comAvisoFinal(8, 49, { relidaEm: ha(2) })).acao).toEqual({ tipo: "nada" });
  });

  it("sem provedor não há leitura a exigir: suspende", () => {
    expect(decidir(comAvisoFinal(8, 49, { temProvedor: false, relidaEm: null })).acao.tipo).toBe("suspender");
  });

  it("⭐ tolerância configurada em 0 vale 5 (piso): 4 dias de atraso não suspendem", () => {
    expect(decidir(comAvisoFinal(4, 49), ATIVA, 0).acao).toEqual({ tipo: "nada" });
  });

  it("prazo extra até amanhã segura a suspensão", () => {
    expect(decidir(comAvisoFinal(10, 72, { prazoExtraAte: em(24) })).acao).toEqual({ tipo: "nada" });
  });

  it("⭐ pagou depois do aviso final do mês passado e a régua acordou tarde: primeiro avisa, só suspende 48 h depois", () => {
    const divida = { estado: "em_atraso" as const, vencidaDesde: ha(24 * 10), ultimoAviso: "suspende_em_breve" as const };
    expect(decidir(a({ ...divida, ultimoAvisoEm: ha(24 * 40) })).acao).toMatchObject({ tipo: "avisar", aviso: "suspende_em_breve" });
    expect(decidir(a({ ...divida, ultimoAvisoEm: ha(49) })).acao.tipo).toBe("suspender");
  });
});

describe("⭐ trial vencido × assinatura atrasada: a tolerância só protege quem pagou (#2753)", () => {
  // D-5 nasceu porque boleto e Pix levam até 1 dia útil para compensar, com um
  // fim de semana no meio. Quem nunca pagou nada não tem nada a compensar: o
  // trial vencido recebe o aviso final no próprio fim do teste e é suspenso
  // 48 h depois, mesmo com a tolerância configurada em 30 dias. Quem JÁ pagou
  // continua com a tolerância de D-5 intacta.
  const fimDoTeste = ha(24 * 6);
  const trialVencido = (p: Partial<AssinaturaNaRegua> = {}) =>
    a({ estado: "trial", temProvedor: false, assinaturasVivas: 0, trialAte: fimDoTeste, relidaEm: null, ...p });

  it("⭐ trial sem pagamento: tolerância 7 e 30 dão o MESMO resultado — aviso final agora, suspensão em 48 h", () => {
    const esperado = { tipo: "avisar", aviso: "suspende_em_breve", debitoDesde: fimDoTeste, data: em(48), origem: "teste" } as const;
    expect(decidir(trialVencido(), ATIVA, 7).acao).toEqual(esperado);
    expect(decidir(trialVencido(), ATIVA, 30).acao).toEqual(esperado);
  });

  it("⭐ trial sem pagamento, aviso final há 49 h: suspende mesmo com tolerância 30", () => {
    const d = trialVencido({ ultimoAviso: "suspende_em_breve", ultimoAvisoEm: ha(49) });
    expect(decidir(d, ATIVA, 30).acao).toEqual({ tipo: "suspender", debitoDesde: fimDoTeste, origem: "teste" });
  });

  it("trial sem pagamento: 47 h 59 min depois do aviso final NÃO suspende — as 48 h seguem valendo", () => {
    const d = trialVencido({ ultimoAviso: "suspende_em_breve", ultimoAvisoEm: ha(47 + 59 / 60) });
    expect(decidir(d, ATIVA, 30).acao).toEqual({ tipo: "nada" });
  });

  it("trial vencido com checkout feito e nada vivo no provedor: a dívida é do teste, não do pagamento", () => {
    const d = a({ estado: "em_atraso", temProvedor: true, assinaturasVivas: 0, trialAte: fimDoTeste, vencidaDesde: fimDoTeste });
    expect(decidir(d, ATIVA, 30).acao).toEqual({
      tipo: "avisar", aviso: "suspende_em_breve", debitoDesde: fimDoTeste, data: em(48), origem: "teste",
    });
  });

  it("⭐ assinatura com pagamento em atraso: a tolerância configurada continua mandando (7 → suspende; 30 → espera)", () => {
    const atraso = comAvisoFinal(10, 49);
    expect(decidir(atraso, ATIVA, 7).acao).toEqual({ tipo: "suspender", debitoDesde: ha(24 * 10), origem: "atraso" });
    expect(decidir(atraso, ATIVA, 30).acao).toEqual({ tipo: "nada" });
  });

  it("⭐ trial que terminou com o 1º boleto/Pix em aberto no provedor (Asaas: vence no fim do teste): espera a tolerância", () => {
    // Pagou no vencimento, a compensação leva até 1 dia útil + fim de semana — o
    // caso exato de D-5. Assinatura viva no provedor = há cobrança em jogo.
    const d = a({ estado: "em_atraso", temProvedor: true, assinaturasVivas: 1, trialAte: ha(1), vencidaDesde: ha(1) });
    expect(decidir(d, ATIVA, 7).acao).toEqual({ tipo: "avisar", aviso: "venceu", debitoDesde: ha(1), data: ha(1), origem: "atraso" });
    const comAviso = { ...d, vencidaDesde: ha(50), trialAte: ha(50), ultimoAviso: "suspende_em_breve" as const, ultimoAvisoEm: ha(49) };
    expect(decidir(comAviso, ATIVA, 7).acao).toEqual({ tipo: "nada" });
  });

  it("entrada paga (plano de 0 dias, D-16) suspensa à espera do 1º pagamento: o lembrete NÃO fala em teste grátis", () => {
    const criada = ha(0.1);
    const d = decidir(a({ estado: "trial", temProvedor: false, assinaturasVivas: 0, trialAte: criada, relidaEm: null, entradaPendente: true }), SUSPENSA_POR_COBRANCA);
    expect(d.acao).toMatchObject({ tipo: "avisar", aviso: "suspensa", origem: "atraso" });
  });

  it("assinatura que já teve trial e voltou a dever (vencida_desde ≠ fim do teste): tolerância normal", () => {
    expect(decidir(comAvisoFinal(6, 49, { trialAte: ha(24 * 60) }), ATIVA, 7).acao).toEqual({ tipo: "nada" });
  });
});

describe("o tipo da suspensão manda", () => {
  it("pagou e está suspensa por cobrança: reativa (ativa ou teste vigente)", () => {
    expect(decidir(a(), SUSPENSA_POR_COBRANCA).acao).toEqual({ tipo: "reativar" });
    expect(decidir(a({ estado: "trial", trialAte: em(24) }), SUSPENSA_POR_COBRANCA).acao).toEqual({ tipo: "reativar" });
  });

  it("suspensa por cobrança e ainda devendo, último aviso há menos de 7 dias: nada", () => {
    expect(decidir(comAvisoFinal(9, 60), SUSPENSA_POR_COBRANCA).acao).toEqual({ tipo: "nada" });
  });

  it("⭐ suspensa por cobrança, devendo, último aviso há mais de 7 dias: lembra com 'suspensa' (a régua recupera receita)", () => {
    const divida = a({ estado: "em_atraso", vencidaDesde: ha(24 * 20), ultimoAviso: "suspensa", ultimoAvisoEm: ha(24 * 7 + 1) });
    expect(decidir(divida, SUSPENSA_POR_COBRANCA).acao).toEqual({
      tipo: "avisar", aviso: "suspensa", debitoDesde: ha(24 * 7), data: ha(24 * 20), origem: "atraso",
    });
  });

  it("⭐ suspensão administrativa: nem reativa, nem avisa", () => {
    expect(decidir(a(), SUSPENSA_ADMINISTRATIVA).acao).toEqual({ tipo: "nada" });
    expect(decidir(a({ estado: "em_atraso", vencidaDesde: ha(24) }), SUSPENSA_ADMINISTRATIVA).acao).toEqual({ tipo: "nada" });
  });

  it("org redigida com assinatura viva: cancela no provedor uma vez, sem aviso", () => {
    expect(decidir(a(), REDIGIDA).acao).toEqual({ tipo: "cancelar_no_provedor" });
    expect(decidir(a({ cancelaNoFim: true }), REDIGIDA).acao).toEqual({ tipo: "nada" });
    expect(decidir(a({ temProvedor: false }), REDIGIDA).acao).toEqual({ tipo: "nada" });
  });
});
