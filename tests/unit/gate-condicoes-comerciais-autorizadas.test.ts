/**
 * Condições comerciais AUTORIZADAS na promise_table (issue #1954).
 *
 * Guarda semântica de promessa (F4-02): o classificador veta em texto livre o que
 * parece promessa. Quando a frase é a OFERTA OFICIAL da organização, isso é
 * falso-positivo. O desenho (dois complementos, desenhados com o mantenedor):
 *
 *  1. `mascararCondicoesAutorizadas` — as condições declaradas são REMOVIDAS do corpo
 *     DA CANDIDATA antes de o classificador julgar. Ele vê só o resto: promessa além
 *     da oferta fica visível → gate veta; oferta sozinha → o resto não é promessa e
 *     passa. O gate `semanticPromiseGate` PERMANECE com exceção zero.
 *  2. `validatePromiseTable` — condição autorizada com mínimo de 3 palavras (evita o
 *     coringa de 1 caractere/palavra).
 *
 * Os testes da tabela A–G são os casos que o mantenedor mediu contra a primeira
 * versão (que usava match/substring no gate) e que o mascaramento passa a tratar
 * corretamente: o resíduo que for promessa continua sendo veto.
 */
import { describe, expect, it } from "vitest";

import {
  semanticPromiseGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { mascararCondicoesAutorizadas } from "@/lib/agent-engine/guardrails/promise/semantic";
import { validatePromiseTable } from "@/lib/agent-engine/guardrails/promise/table";

const CONDICAO = "teste de 7 dias, sem cartão";

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-09-30T00:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

describe("mascararCondicoesAutorizadas — remove a oferta, deixa a promessa visível (tabela A–G do mantenedor)", () => {
  it("A: condição + promessa NOVA → a promessa fica visível para o classificador vetar", () => {
    const masc = mascararCondicoesAutorizadas(
      "teste de 7 dias, sem cartão e desconto de 50% garantido",
      [CONDICAO],
    );
    expect(masc).not.toContain("teste de 7 dias, sem cartao");
    expect(masc).toContain("desconto de 50% garantido");
  });

  it("B: sintoma de suspeita nula — deixa o pedaço que promete no restante", () => {
    const masc = mascararCondicoesAutorizadas(
      "teste de 7 dias, sem cartão. E te dou o 1o mês de graça.",
      [CONDICAO],
    );
    expect(masc).not.toContain("teste de 7 dias, sem cartao");
    expect(masc).toContain("1o mes de graca");
  });

  it("C: duas promessas na mesma mensagem — a segunda fica visível", () => {
    const masc = mascararCondicoesAutorizadas(
      "teste de 7 dias, sem cartão e entrego amanhã de graça",
      [CONDICAO],
    );
    expect(masc).not.toContain("teste de 7 dias, sem cartao");
    expect(masc).toContain("entrego amanha de graca");
  });

  it("D: condição longa — só a condição COMPLETA mascara, trecho curto avulso não", () => {
    const longa = "demonstração de 15 minutos é gratuita e sem compromisso";
    const masc = mascararCondicoesAutorizadas("Sobre o sem compromisso, tudo bem?", [longa]);
    expect(masc).toContain("sem compromisso");
  });

  it("G: coringa de 1 caractere/palavra falha a validação (nunca vira condição)", () => {
    expect(() => validatePromiseTable({ condicoesAutorizadas: ["a"] })).toThrow(/3 palavras/);
    expect(() => validatePromiseTable({ condicoesAutorizadas: ["grátis"] })).toThrow(/3 palavras/);
  });

  it("sem lista → corpo inalterado (comportamento atual)", () => {
    const corpo = "te dou desconto de 80% de graça";
    expect(mascararCondicoesAutorizadas(corpo, undefined)).toBe(corpo);
  });

  it("sem ocorrência da condição → corpo inalterado", () => {
    const corpo = "te dou 50% de desconto hoje";
    expect(mascararCondicoesAutorizadas(corpo, [CONDICAO])).toBe(corpo);
  });

  it("caixa/acento diferentes ainda mascaram (normaliza antes de comparar)", () => {
    const masc = mascararCondicoesAutorizadas(
      "O TESTE É DE 7 DIAS, SEM CARTÃO, e você não paga nada.",
      ["Teste de 7 dias, sem cartão"],
    );
    expect(masc).not.toContain("teste de 7 dias, sem cartao");
  });
});

describe("semanticPromiseGate — exceção ZERO: veta sempre que o classificador acha promessa", () => {
  it("veta quando o classificador destacou promessa, mesmo com condição autorizada declarada", () => {
    const v = semanticPromiseGate.evaluate(
      baseCtx({
        body: "teste de 7 dias, sem cartão e desconto de 50% garantido",
        semanticPromise: { isPromise: true, suspectPhrase: "desconto de 50% garantido" },
        promise: {
          table: { condicoesAutorizadas: [CONDICAO] },
          versionId: "v1",
        },
      }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("promise_semantic");
  });

  it("sem promessa → passa", () => {
    const v = semanticPromiseGate.evaluate(
      baseCtx({
        body: "bom dia, tudo bem?",
        semanticPromise: { isPromise: false, suspectPhrase: null },
        promise: { table: { condicoesAutorizadas: [CONDICAO] }, versionId: "v1" },
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("sem tabela (org não fiscaliza) → veta como antes", () => {
    const v = semanticPromiseGate.evaluate(
      baseCtx({
        body: "te dou 1000 de graça",
        semanticPromise: { isPromise: true, suspectPhrase: "te dou 1000 de graça" },
        promise: { table: null },
      }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("promise_semantic");
  });
});

describe("validatePromiseTable — condicoesAutorizadas válida para mascarar", () => {
  it("aceita e normaliza (trim)", () => {
    const t = validatePromiseTable({
      condicoesAutorizadas: [" teste de 7 dias, sem cartão ", "demonstração de 15 minutos é gratuita"],
    });
    expect(t.condicoesAutorizadas).toEqual([
      "teste de 7 dias, sem cartão",
      "demonstração de 15 minutos é gratuita",
    ]);
  });

  it("rejeita não-array", () => {
    expect(() => validatePromiseTable({ condicoesAutorizadas: "nao é array" })).toThrow(
      /condicoesAutorizadas/,
    );
  });

  it("rejeita item vazio", () => {
    expect(() => validatePromiseTable({ condicoesAutorizadas: ["ok legal isso daqui", "  "] })).toThrow(
      /condicoesAutorizadas/,
    );
  });

  it("rejeita condição com menos de 3 palavras (coringa)", () => {
    expect(() => validatePromiseTable({ condicoesAutorizadas: ["grátis"] })).toThrow(/3 palavras/);
    expect(() => validatePromiseTable({ condicoesAutorizadas: ["a"] })).toThrow(/3 palavras/);
  });
});