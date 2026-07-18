import { describe, it, expect } from "vitest";
import { withinSendWindow, nextWindowStart, jitterMs } from "@/lib/automation/throttle";

describe("withinSendWindow", () => {
  it("10h → true", () => expect(withinSendWindow(new Date("2026-07-17T10:00:00"))).toBe(true));
  it("06:59 → false", () => expect(withinSendWindow(new Date("2026-07-17T06:59:00"))).toBe(false));
  it("22:00 → false (janela é [7,22))", () => expect(withinSendWindow(new Date("2026-07-17T22:00:00"))).toBe(false));
});

describe("nextWindowStart", () => {
  it("às 23h retorna 7h de AMANHÃ", () => {
    const next = new Date(nextWindowStart(new Date("2026-07-17T23:00:00")));
    expect(next.getHours()).toBe(7);
    expect(next.getDate()).toBe(18);
  });
  it("às 5h retorna 7h de HOJE", () => {
    const next = new Date(nextWindowStart(new Date("2026-07-17T05:00:00")));
    expect(next.getHours()).toBe(7);
    expect(next.getDate()).toBe(17);
  });
});

describe("jitterMs", () => {
  it("sempre em [0, 800]", () => {
    for (let i = 0; i < 50; i++) {
      const j = jitterMs();
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(800);
    }
  });
});
