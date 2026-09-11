import { describe, expect, it } from "vitest";

import {
  academiaGradeStallGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-09-10T13:00:00Z"),
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

describe("academiaGradeStallGate", () => {
  it.each([
    "Vou consultar a grade e já te retorno.",
    "Posso verificar isso para você?",
    "Estou verificando e aviso assim que souber.",
  ])("veta a evasão medida sem execução da consulta: %s", (body) => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body,
        academiaGrade: { active: true, toolCalledThisTurn: false },
      }),
    );
    expect(verdict.pass).toBe(false);
    if (verdict.pass) throw new Error("inalcançável");
    expect(verdict.code).toBe("academia_grade_stall_sem_ferramenta");
    expect(verdict.reason).toContain("crm_find_academia_classes");
  });

  it("veta horário de aula afirmado sem consultar a grade", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body: "O CrossFit de segunda-feira é às 08:00.",
        academiaGrade: { active: true, toolCalledThisTurn: false },
      }),
    );
    expect(verdict.pass).toBe(false);
  });

  it("libera a resposta factual depois que a tool executou no turno", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body: "O CrossFit de segunda-feira é às 08:00.",
        academiaGrade: { active: true, toolCalledThisTurn: true },
      }),
    );
    expect(verdict.pass).toBe(true);
  });

  it("é no-op para agente ou conversa sem a capacidade armada", () => {
    const body = "Vou verificar isso para você.";
    expect(academiaGradeStallGate.evaluate(baseCtx({ body })).pass).toBe(true);
    expect(
      academiaGradeStallGate.evaluate(
        baseCtx({ body, academiaGrade: { active: false, toolCalledThisTurn: false } }),
      ).pass,
    ).toBe(true);
  });

  it("permite explicar o limite de data específica e encaminhar", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body:
          "A grade que tenho é semanal. Para confirmar a próxima segunda-feira, nossa equipe vai te atender.",
        academiaGrade: { active: true, toolCalledThisTurn: false },
      }),
    );
    expect(verdict.pass).toBe(true);
  });
});
