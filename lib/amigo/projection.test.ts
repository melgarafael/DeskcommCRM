import { describe, expect, it } from "vitest";
import { normalizeAttendance, localStatusForAmigo } from "./projection";

describe("projeção de consultas Amigo", () => {
  it("recusa hora civil inválida em vez de rolar para outro dia", async () => {
    const { amigoInstant } = await import("./projection");
    expect(() => amigoInstant("2026-02-30 14:00", "America/Fortaleza")).toThrow();
    expect(() => amigoInstant("2026-11-07 25:00", "America/Fortaleza")).toThrow();
  });
  it("preserva estados operacionais sem chamar horário passado de presença", () => {
    expect(localStatusForAmigo("scheduled")).toBe("confirmed");
    expect(localStatusForAmigo("confirmed")).toBe("confirmed");
    expect(localStatusForAmigo("arrived")).toBe("confirmed");
    expect(localStatusForAmigo("in_attendance")).toBe("confirmed");
    expect(localStatusForAmigo("done")).toBe("completed");
    expect(localStatusForAmigo("missed")).toBe("no_show");
    expect(localStatusForAmigo("canceled")).toBe("cancelled");
    expect(() => localStatusForAmigo("desconhecido")).toThrow();
  });
  it("conserva instante UTC, origem e profissional sem exigir usuário do CRM", () => {
    const r = normalizeAttendance(
      {
        id: 76,
        patient_id: 19,
        event_id: 3,
        start_date: "2026-11-07T17:00:00.000Z",
        end_date: "2026-11-07T17:30:00.000Z",
        status: "scheduled",
        user: { id: 8, name: "Profissional teste" },
        agenda_event: { id: 3, name: "Consulta" },
        place: { id: 5, name: "Unidade teste" },
        patient: { id: 19, name: "Paciente teste" },
      },
      "America/Fortaleza",
    );
    expect(r).toMatchObject({
      remoteId: 76,
      patientId: 19,
      remoteStatus: "scheduled",
      startsAt: "2026-11-07T17:00:00.000Z",
      endsAt: "2026-11-07T17:30:00.000Z",
      localStatus: "confirmed",
      doctorId: 8,
      placeId: 5,
      title: "Consulta",
      arrivalOrder: false,
    });
  });
  it("não inventa horário nem duração quando a resposta é incompleta", () => {
    expect(() =>
      normalizeAttendance({ id: 1, patient_id: 19, start_date: "amanhã" }, "America/Fortaleza"),
    ).toThrow();
  });
});
