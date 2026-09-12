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

  it("veta oferta de vaga ou reserva que a pessoa não pediu", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body:
          "O CrossFit é segunda, das 08:00 às 09:00, no Box. Quer que eu reserve uma vaga?",
        academiaGrade: {
          active: true,
          toolCalledThisTurn: true,
          commercialFollowupAllowed: false,
        },
      }),
    );
    expect(verdict.pass).toBe(false);
    if (verdict.pass) throw new Error("inalcançável");
    expect(verdict.code).toBe("academia_grade_oferta_nao_solicitada");
  });

  it("permite tratar vaga quando a própria pessoa pediu", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body:
          "O CrossFit é segunda, das 08:00 às 09:00, no Box. Vou verificar a disponibilidade da vaga.",
        academiaGrade: {
          active: true,
          toolCalledThisTurn: true,
          commercialFollowupAllowed: true,
        },
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

  it("permite responder sobre feriado com handoff sem afirmar horário", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body:
          "A grade é semanal e não cobre feriados. Para saber se haverá aula no feriado, vou te encaminhar para nossa equipe.",
        academiaGrade: { active: true, toolCalledThisTurn: false },
      }),
    );
    expect(verdict.pass).toBe(true);
  });

  it("veta afirmação de funcionamento em feriado sem consulta", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body: "No feriado a academia abre das 08:00 às 12:00.",
        academiaGrade: { active: true, toolCalledThisTurn: false },
      }),
    );
    expect(verdict.pass).toBe(false);
    if (verdict.pass) throw new Error("inalcançável");
    expect(verdict.code).toBe("academia_grade_stall_sem_ferramenta");
  });

  it("permite handoff após consulta quando a pergunta é sobre exceção", () => {
    const verdict = academiaGradeStallGate.evaluate(
      baseCtx({
        body:
          "A grade regular de CrossFit é segunda às 08:00. Como você perguntou sobre o feriado, vou te encaminhar para a equipe confirmar.",
        academiaGrade: { active: true, toolCalledThisTurn: true },
      }),
    );
    expect(verdict.pass).toBe(true);
  });
});
