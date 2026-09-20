import { describe, expect, it } from "vitest";
import { allowanceView } from "./ai-allowance-view";
const now = Date.parse("2026-09-20T12:00:00Z");
const row = {
  status: "active",
  current_period_start: "2026-09-01T00:00:00Z",
  current_period_end: "2026-10-01T00:00:00Z",
  budget: "3000",
  rate: "6",
  used: "123.50",
  reserved: "100",
  unknown_count: "0",
};
describe("commercial AI balance", () => {
  it("subtracts settled consumption and outstanding reservations in cents", () => {
    expect(allowanceView(row, now)).toMatchObject({
      status: "ready",
      remaining: 2776.5,
      used: 123.5,
      reserved: 100,
    });
  });
  it("does not infer an unconfirmed cycle", () => {
    expect(allowanceView({ ...row, current_period_start: null }, now)).toMatchObject({
      status: "unconfirmed",
      periodStart: null,
      periodEnd: null,
    });
  });
  it("flags unresolved charges instead of claiming spendable credit", () => {
    expect(allowanceView({ ...row, unknown_count: "1" }, now).status).toBe("review");
  });
  it.each(["pending", "past_due", "canceled"])("marks %s credit inactive", (status) => {
    expect(allowanceView({ ...row, status }, now).status).toBe("inactive");
  });
  it("expires exactly at the cycle boundary and does not activate future cycles", () => {
    expect(allowanceView(row, Date.parse(row.current_period_end)).status).toBe("inactive");
    expect(allowanceView(row, Date.parse(row.current_period_start) - 1).status).toBe("inactive");
  });
  it.each([{ budget: null }, { rate: "NaN" }, { used: "Infinity" }, { reserved: "-1" }])(
    "rejects corrupt financial data: %j",
    (patch) => {
      expect(() => allowanceView({ ...row, ...patch }, now)).toThrow(
        "Invalid AI allowance snapshot",
      );
    },
  );
});
