import { describe, expect, it } from "vitest";

import { nativasDoTurno, type CapacidadeDoTurno } from "./nativas-do-turno";

const FAQ: CapacidadeDoTurno = {
  contextoJaNaAbertura: true,
  compactacaoRodou: false,
  followupHabilitadoNoAgente: false,
  janelaDeFollowupConfigurada: true,
  handoffHabilitado: false,
  funilGravavel: false,
  notasUtilizaveis: false,
  conhecimentoDisponivel: false,
  casosHabilitados: false,
};

describe("nativasDoTurno", () => {
  it("FAQ com contexto na abertura não oferece get_lead_context no primeiro passo", () => {
    expect(nativasDoTurno(FAQ)).toEqual(["send_message"]);
    expect(nativasDoTurno(FAQ)).not.toContain("get_lead_context");
  });

  it("reoferece get_lead_context depois da compactação ou sem contexto na abertura", () => {
    expect(nativasDoTurno({ ...FAQ, compactacaoRodou: true })).toContain("get_lead_context");
    expect(nativasDoTurno({ ...FAQ, contextoJaNaAbertura: false })).toContain("get_lead_context");
  });

  it("schedule_followup ausente quando o follow-up do agente está desligado, mesmo com janela de env", () => {
    expect(nativasDoTurno(FAQ)).not.toContain("schedule_followup");
    expect(
      nativasDoTurno({
        ...FAQ,
        followupHabilitadoNoAgente: true,
        janelaDeFollowupConfigurada: true,
      }),
    ).toContain("schedule_followup");
    expect(
      nativasDoTurno({
        ...FAQ,
        followupHabilitadoNoAgente: true,
        janelaDeFollowupConfigurada: false,
      }),
    ).not.toContain("schedule_followup");
  });

  it("handoff, notas e funil ausentes quando desligados e reaparecem quando ligados", () => {
    expect(nativasDoTurno(FAQ)).not.toContain("request_human_handoff");
    expect(nativasDoTurno(FAQ)).not.toContain("update_lead_state");
    expect(nativasDoTurno(FAQ)).not.toContain("save_lead_note");
    expect(nativasDoTurno(FAQ)).not.toContain("get_lead_note");
    expect(nativasDoTurno({ ...FAQ, handoffHabilitado: true })).toContain("request_human_handoff");
    expect(nativasDoTurno({ ...FAQ, funilGravavel: true })).toContain("update_lead_state");
    expect(nativasDoTurno({ ...FAQ, notasUtilizaveis: true })).toEqual(
      expect.arrayContaining(["save_lead_note", "get_lead_note"]),
    );
  });

  it("send_message continua disponível", () => {
    expect(nativasDoTurno(FAQ)).toContain("send_message");
    expect(
      nativasDoTurno({
        ...FAQ,
        handoffHabilitado: true,
        funilGravavel: true,
        notasUtilizaveis: true,
        conhecimentoDisponivel: true,
        casosHabilitados: true,
        followupHabilitadoNoAgente: true,
      }),
    ).toContain("send_message");
  });

  it("conhecimento e casos só entram quando a capacidade existe", () => {
    expect(nativasDoTurno(FAQ)).not.toContain("search_knowledge");
    expect(nativasDoTurno(FAQ)).not.toContain("open_human_case");
    expect(nativasDoTurno({ ...FAQ, conhecimentoDisponivel: true })).toContain("search_knowledge");
    expect(nativasDoTurno({ ...FAQ, casosHabilitados: true })).toEqual(
      expect.arrayContaining(["open_human_case", "provide_case_update"]),
    );
  });
});
