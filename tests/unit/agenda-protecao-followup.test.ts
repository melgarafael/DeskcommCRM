import { describe, expect, it } from "vitest";
import { protecaoDaAgenda, type CompromissoProtetor } from "@/lib/agenda/protecao-followup";
import { classifyRisk, resolveStageWindow } from "@/lib/leads/risk-radar";
const start = Date.parse("2026-09-06T12:00:00Z");
const a: CompromissoProtetor = {
  id: "appointment",
  contact_id: "contact",
  revision: 1,
  status: "confirmed",
  starts_at: new Date(start).toISOString(),
  ends_at: new Date(start + 3600000).toISOString(),
};
const at = (hours: number) => new Date(start + hours * 3600000);
describe("agenda protege cobrança sem inventar presença", () => {
  it.each([
    [-1, "agendado"],
    [0.5, "em_atendimento"],
    [1.2, "presenca_pendente"],
    [24.9, "presenca_pendente"],
  ])("em %s horas conserva proteção %s", (hours, reason) => {
    expect(protecaoDaAgenda([a], undefined, at(Number(hours)))).toMatchObject({
      adiar: true,
      motivo: reason,
      appointment_id: a.id,
    });
  });
  it("ao vencer libera só a proteção, mantendo o motivo para revisão", () => {
    expect(protecaoDaAgenda([a], undefined, at(25))).toMatchObject({
      adiar: false,
      motivo: "presenca_vencida",
    });
    expect(a.status).toBe("confirmed");
  });
  it("outro compromisso futuro ainda protege mesmo com desconhecido vencido", () => {
    const future = {
      ...a,
      id: "future",
      starts_at: at(30).toISOString(),
      ends_at: at(31).toISOString(),
    };
    expect(protecaoDaAgenda([a, future], undefined, at(26))).toMatchObject({
      adiar: true,
      appointment_id: "future",
      motivo: "agendado",
    });
  });
  it.each(["cancelled", "completed", "no_show"])("desfecho %s não protege", (status) => {
    expect(protecaoDaAgenda([{ ...a, status }], undefined, at(2))).toMatchObject({
      adiar: false,
      motivo: "sem_compromisso",
    });
  });
  it("prazos válidos da organização alteram o horizonte", () => {
    expect(
      protecaoDaAgenda(
        [a],
        { confirmation_delay_minutes: 5, unknown_protection_minutes: 60 },
        at(2),
      ),
    ).toMatchObject({ adiar: false, motivo: "presenca_vencida" });
  });
  it("Radar não acusa abandono durante proteção e escala desconhecido mesmo com lead fresco", () => {
    const input = {
      lastActivityAt: at(24.9),
      now: at(25),
      inFlight: false,
      window: resolveStageWindow(null),
    };
    expect(
      classifyRisk({ ...input, agenda: protecaoDaAgenda([a], undefined, at(25)) }),
    ).toMatchObject({ bucket: "critico", onRadar: true });
    expect(
      classifyRisk({ ...input, agenda: protecaoDaAgenda([a], undefined, at(24.9)) }),
    ).toMatchObject({ bucket: "em_voo", onRadar: true });
  });
});
