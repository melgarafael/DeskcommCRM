/**
 * Condições comerciais AUTORIZADAS na promise_table (issue #1954).
 *
 * O que está em jogo: o classificador semântico de promessa (F4-02) veta frases
 * em texto livre que pareçam promessa/compromisso. Quando a frase é a OFERTA
 * OFICIAL da organização ("teste de 7 dias, sem cartão", "demonstração de 15
 * minutos"), o veto é falso-positivo: corta da resposta a condição pública da
 * empresa e deixa o lead sem saber que não será cobrado.
 *
 * A cura (não regex livre, MESMO mecanismo dos outros knobs da promise_table —
 * lista versionada por ponteiro): se a frase destacada do corpo reproduz
 * literalmente uma `condicaoAutorizada` declarada pela org, o gate semântico
 * NÃO veta. Sem condição declarada = comportamento atual (veta).
 */
import { describe, expect, it } from "vitest";

import {
  semanticPromiseGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { condicaoAutorizadaCobre } from "@/lib/agent-engine/guardrails/promise/semantic";
import { validatePromiseTable } from "@/lib/agent-engine/guardrails/promise/table";

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

describe("condicaoAutorizadaCobre — match literal normalizado, sem regex livre", () => {
  it("cobre quando a frase destacada reproduz literalmente a condição (diferença só de caixa/acento)", () => {
    const c = condicaoAutorizadaCobre(
      "O teste é de 7 dias, sem cartão, e não cobra nada no fim.",
      "Teste de 7 dias, sem cartão",
      ["teste de 7 dias, sem cartão"],
    );
    expect(c).toBe("teste de 7 dias, sem cartão");
  });

  it("cobre quando a condição autorizada é frase mais longa que a suspeita (contém)", () => {
    const c = condicaoAutorizadaCobre(
      "Sobre a demonstração de 15 minutos, tudo bem.",
      "demonstração de 15 minutos",
      ["demonstração de 15 minutos é gratuita e sem compromisso"],
    );
    expect(c).toBe("demonstração de 15 minutos é gratuita e sem compromisso");
  });

  it("NÃO cobre sem lista — comportamento atual (gate veta)", () => {
    expect(condicaoAutorizadaCobre("ganho você de graça", "ganho você de graça", undefined)).toBeNull();
  });

  it("NÃO cobre promessa que não está na lista autorizada", () => {
    const c = condicaoAutorizadaCobre(
      "te dou 50% de desconto de graça hoje",
      "50% de desconto de graça",
      ["teste de 7 dias, sem cartão"],
    );
    expect(c).toBeNull();
  });
});

describe("semanticPromiseGate — a oferta oficial declarada NÃO veta; o resto veta como hoje", () => {
  it("⭐ passa quando a frase suspeita é coberta por uma condição autorizada da org (caso da issue)", () => {
    const v = semanticPromiseGate.evaluate(
      baseCtx({
        body: "O teste é de 7 dias, sem cartão, e não cobra nada no fim.",
        semanticPromise: { isPromise: true, suspectPhrase: "teste de 7 dias, sem cartão" },
        promise: {
          table: { condicoesAutorizadas: ["teste de 7 dias, sem cartão"] },
          versionId: "v1",
        },
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("passa COM caixa/acento diferentes (oferta declarada 'Teste de 7 dias, sem cartão')", () => {
    const v = semanticPromiseGate.evaluate(
      baseCtx({
        body: "O TESTE É DE 7 DIAS, SEM CARTÃO, e você não paga nada.",
        semanticPromise: { isPromise: true, suspectPhrase: "TESTE DE 7 DIAS, SEM CARTÃO" },
        promise: {
          table: { condicoesAutorizadas: ["Teste de 7 dias, sem cartão"] },
          versionId: "v1",
        },
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("veta ético quando há lista mas a frase NÃO está coberta (promessa fora da oferta)", () => {
    const v = semanticPromiseGate.evaluate(
      baseCtx({
        body: "te dou desconto de 80% de graça",
        semanticPromise: { isPromise: true, suspectPhrase: "desconto de 80% de graça" },
        promise: {
          table: { condicoesAutorizadas: ["teste de 7 dias, sem cartão"] },
          versionId: "v1",
        },
      }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("promise_semantic");
  });

  it("sem tabela (org não fiscaliza): veta como hoje — nunca passa por vacuidade", () => {
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

describe("validatePromiseTable — aceita condicoesAutorizadas, rejeita shaped errado", () => {
  it("aceita a lista e a normaliza (trim)", () => {
    const t = validatePromiseTable({ condicoesAutorizadas: [" teste de 7 dias ", "demo 15min"] });
    expect(t.condicoesAutorizadas).toEqual(["teste de 7 dias", "demo 15min"]);
  });

  it("rejeita não-array", () => {
    expect(() => validatePromiseTable({ condicoesAutorizadas: "nao é array" })).toThrow(
      /condicoesAutorizadas/,
    );
  });

  it("rejeita item vazio", () => {
    expect(() => validatePromiseTable({ condicoesAutorizadas: ["ok", "  "] })).toThrow(
      /condicoesAutorizadas/,
    );
  });
});