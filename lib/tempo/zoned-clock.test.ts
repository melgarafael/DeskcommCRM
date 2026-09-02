// lib/tempo/zoned-clock.test.ts
import { describe, expect, it } from "vitest";
import { wallClockParts, instantFromWallClock } from "./zoned-clock";

describe("wallClockParts", () => {
  it("lê a hora de parede correta num fuso com offset negativo", () => {
    // 2026-08-30T12:00:00Z em America/Sao_Paulo (UTC-3) = 09:00 local
    const parts = wallClockParts(new Date("2026-08-30T12:00:00Z"), "America/Sao_Paulo");
    expect(parts).toEqual({ year: 2026, month: 8, day: 30, hour: 9, minute: 0, weekday: 0 });
    // 2026-08-30 é domingo — weekday 0
  });

  it("lê a hora de parede correta em Africa/Maputo (UTC+2, sem DST)", () => {
    const parts = wallClockParts(new Date("2026-08-30T12:00:00Z"), "Africa/Maputo");
    expect(parts).toEqual({ year: 2026, month: 8, day: 30, hour: 14, minute: 0, weekday: 0 });
  });
});

describe("instantFromWallClock", () => {
  it("é o inverso de wallClockParts", () => {
    const instant = instantFromWallClock(2026, 8, 30, 14, 30, "America/Sao_Paulo");
    const parts = wallClockParts(instant, "America/Sao_Paulo");
    expect(parts).toMatchObject({ year: 2026, month: 8, day: 30, hour: 14, minute: 30 });
  });

  it("dois fusos diferentes para a MESMA hora de parede produzem instantes diferentes", () => {
    const saoPaulo = instantFromWallClock(2026, 8, 30, 9, 0, "America/Sao_Paulo");
    const maputo = instantFromWallClock(2026, 8, 30, 9, 0, "Africa/Maputo");
    expect(saoPaulo.getTime()).not.toBe(maputo.getTime());
  });
});
