import { describe, expect, it } from "vitest";

import { casePromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * #2916 (resíduo) — a promessa de RETORNO do próprio assistente não é assunto de
 * caso humano, é de follow-up. Com os casos DESLIGADOS (o padrão de um agente
 * novo), o gate saía na primeira linha (`if (!ctx.casesEnabled) return pass`) e a
 * frase "Combinado, retomamos daqui a duas horas" ia para o cliente sem nada
 * agendado — o cliente esperando uma mensagem que não vem.
 *
 * O caso de teste é o cenário medido na issue: 3 de 11 execuções confirmavam o
 * retorno sem chamar `schedule_followup`.
 */

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-11-02T12:00:00Z"),
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

const RETORNO = "Combinado, retomamos daqui a duas horas.";
const RETORNO_COM_FOLLOWUP = { disponivel: true, agendadoNesteTurno: true };
const RETORNO_SEM_FOLLOWUP = { disponivel: true, agendadoNesteTurno: false };

describe("casePromiseGate — retorno do assistente com os casos DESLIGADOS (#2916)", () => {
  it("veta: frase de retorno + follow-up NÃO agendado, mesmo sem casos", () => {
    const verdict = casePromiseGate.evaluate(
      ctx({ casesEnabled: false, body: RETORNO, followup: RETORNO_SEM_FOLLOWUP }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) {
      expect(verdict.code).toBe("followup_promise_without_followup");
      expect(verdict.reason).toMatch(/schedule_followup/);
    }
  });

  it("passa: frase de retorno + follow-up agendado no turno", () => {
    const verdict = casePromiseGate.evaluate(
      ctx({ casesEnabled: false, body: RETORNO, followup: RETORNO_COM_FOLLOWUP }),
    );
    expect(verdict.pass).toBe(true);
  });

  it("passa: promessa de HUMANO segue liberada sem casos (não é o alvo deste gate)", () => {
    const verdict = casePromiseGate.evaluate(
      ctx({
        casesEnabled: false,
        body: "vou verificar com a equipe e te retorno",
        followup: RETORNO_SEM_FOLLOWUP,
      }),
    );
    expect(verdict.pass).toBe(true);
  });

  it("veta sem ensinar ferramenta inexistente quando o agente não tem schedule_followup", () => {
    const verdict = casePromiseGate.evaluate(
      ctx({
        casesEnabled: false,
        body: RETORNO,
        followup: { disponivel: false, agendadoNesteTurno: false },
      }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) {
      expect(verdict.code).toBe("followup_promise_without_followup");
      expect(verdict.reason).not.toMatch(/schedule_followup/);
      expect(verdict.reason).toMatch(/[Rr]eformule/);
    }
  });

  it("passa: caminho de envio que não informa o retorno (followup ausente)", () => {
    const verdict = casePromiseGate.evaluate(ctx({ casesEnabled: false, body: RETORNO }));
    expect(verdict.pass).toBe(true);
  });

  it("casos LIGADOS: comportamento antigo intacto (código e razão de caso)", () => {
    const verdict = casePromiseGate.evaluate(
      ctx({ casesEnabled: true, body: RETORNO, followup: RETORNO_SEM_FOLLOWUP }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) {
      expect(verdict.code).toBe("case_promise_without_case");
      expect(verdict.reason).toMatch(/open_human_case/);
    }
  });

  it("casos LIGADOS com caso aberto: passa, como antes", () => {
    const verdict = casePromiseGate.evaluate(
      ctx({ casesEnabled: true, hasOpenCase: true, body: RETORNO, followup: RETORNO_SEM_FOLLOWUP }),
    );
    expect(verdict.pass).toBe(true);
  });
});
