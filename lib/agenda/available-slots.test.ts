import { describe, expect, it } from "vitest";
import { computeAvailableSlots } from "./available-slots";

const TZ = "Africa/Maputo"; // UTC+2, sem DST — facilita a leitura do teste

describe("computeAvailableSlots", () => {
  it("sem horário cadastrado para o dia: nenhum slot", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 30,
      scheduleBlocks: [],
      existingAppointments: [],
    });
    expect(slots).toEqual([]);
  });

  it("horário 09:00-11:00, duração 30min, sem agendamentos: 4 slots de 30min", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 30,
      scheduleBlocks: [{ starts_at: "09:00:00", ends_at: "11:00:00" }],
      existingAppointments: [],
    });
    expect(slots).toHaveLength(4);
    expect(slots[0]).toEqual({
      startsAt: "2026-09-01T07:00:00.000Z", // 09:00 Maputo = 07:00 UTC
      endsAt: "2026-09-01T07:30:00.000Z",
    });
    expect(slots[3]).toEqual({
      startsAt: "2026-09-01T08:30:00.000Z", // 10:30 Maputo
      endsAt: "2026-09-01T09:00:00.000Z",
    });
  });

  it("horário parcialmente ocupado: o slot que colide com um agendamento existente some", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 30,
      scheduleBlocks: [{ starts_at: "09:00:00", ends_at: "10:00:00" }],
      existingAppointments: [
        { scheduled_at: "2026-09-01T07:00:00.000Z", duration_minutes: 30 }, // 09:00-09:30 Maputo
      ],
    });
    // Só sobra o slot 09:30-10:00
    expect(slots).toEqual([
      { startsAt: "2026-09-01T07:30:00.000Z", endsAt: "2026-09-01T08:00:00.000Z" },
    ]);
  });

  it("múltiplos blocos no mesmo dia (manhã e tarde) — cada um gera seus slots", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 60,
      scheduleBlocks: [
        { starts_at: "08:00:00", ends_at: "09:00:00" },
        { starts_at: "14:00:00", ends_at: "15:00:00" },
      ],
      existingAppointments: [],
    });
    expect(slots).toHaveLength(2);
    expect(slots[0]!.startsAt).toBe("2026-09-01T06:00:00.000Z"); // 08:00 Maputo
    expect(slots[1]!.startsAt).toBe("2026-09-01T12:00:00.000Z"); // 14:00 Maputo
  });

  it("duração do agendamento maior que o slot restante no bloco: nenhum slot ali", () => {
    const slots = computeAvailableSlots({
      date: "2026-09-01",
      timezone: TZ,
      durationMinutes: 45,
      scheduleBlocks: [{ starts_at: "09:00:00", ends_at: "09:30:00" }], // só 30min de bloco
      existingAppointments: [],
    });
    expect(slots).toEqual([]);
  });
});
