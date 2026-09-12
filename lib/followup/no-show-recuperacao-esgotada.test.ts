import { describe, expect, it } from "vitest";

import type { EnrollmentRow, NodeResult } from "./node-handlers";
import { avisoDeRecuperacaoEsgotada } from "./no-show-recuperacao-esgotada";

const enrollmentBase: EnrollmentRow = {
  id: "enr-1",
  organization_id: "org-1",
  pointer_id: "ptr-1",
  version_id: "ver-1",
  contact_id: "contact-1",
  conversation_id: "conv-1",
  current_node_id: "r3",
  status: "waiting_reply",
  next_eval_at: null,
  claimed_until: null,
  attempts: 0,
  max_attempts: 3,
  last_error: null,
  steps_taken: 6,
  outcome: null,
  cancel_reason: null,
  started_at: "2026-09-09T12:00:00.000Z",
  completed_at: null,
  updated_at: "2026-09-09T12:00:00.000Z",
  appointment_id: "appt-1",
  appointment_revision: 2,
};

const esgotou: NodeResult = { kind: "complete", outcome: "exhausted" };

describe("avisoDeRecuperacaoEsgotada", () => {
  it("abre aviso quando a régua de no-show esgota sem resposta", () => {
    expect(avisoDeRecuperacaoEsgotada(enrollmentBase, esgotou, false)).toEqual({
      organization_id: "org-1",
      appointment_id: "appt-1",
      appointment_revision: 2,
      ref_enrollment_id: "enr-1",
    });
  });

  it("carrega revisão null quando o enrollment não tem (compat)", () => {
    const semRev = { ...enrollmentBase, appointment_revision: null };
    expect(avisoDeRecuperacaoEsgotada(semRev, esgotou, false)?.appointment_revision).toBeNull();
  });

  it("não avisa em replay — o reprocesso não reabre o aviso", () => {
    expect(avisoDeRecuperacaoEsgotada(enrollmentBase, esgotou, true)).toBeNull();
  });

  it("não avisa quando o cliente respondeu (outcome replied) nem no ramo fora do alvo (outcome null)", () => {
    expect(
      avisoDeRecuperacaoEsgotada(enrollmentBase, { kind: "complete", outcome: "replied" }, false),
    ).toBeNull();
    expect(
      avisoDeRecuperacaoEsgotada(
        enrollmentBase,
        { kind: "complete", outcome: null, cancel_reason: "fora do alvo" },
        false,
      ),
    ).toBeNull();
  });

  it("não avisa quando o fluxo só avançou (não concluiu)", () => {
    const avanco: NodeResult = {
      kind: "advance",
      next_node_id: "m3",
      next_eval_at: new Date("2026-09-09T15:00:00.000Z"),
    };
    expect(avisoDeRecuperacaoEsgotada(enrollmentBase, avanco, false)).toBeNull();
  });

  it("não avisa quando o enrollment não veio de uma falta (sem appointment_id)", () => {
    const semAppt = { ...enrollmentBase, appointment_id: null };
    expect(avisoDeRecuperacaoEsgotada(semAppt, esgotou, false)).toBeNull();
  });
});
