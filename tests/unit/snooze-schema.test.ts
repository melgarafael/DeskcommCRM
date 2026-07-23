import { describe, expect, it } from "vitest";

import { snoozeSchema } from "@/lib/schemas/snooze";

describe("snoozeSchema", () => {
  it("aceita duration_hours 1, 3 e 24", () => {
    expect(snoozeSchema.safeParse({ duration_hours: 1 }).success).toBe(true);
    expect(snoozeSchema.safeParse({ duration_hours: 3 }).success).toBe(true);
    expect(snoozeSchema.safeParse({ duration_hours: 24 }).success).toBe(true);
  });
  it("rejeita valores fora do enum fechado", () => {
    expect(snoozeSchema.safeParse({ duration_hours: 0 }).success).toBe(false);
    expect(snoozeSchema.safeParse({ duration_hours: 5 }).success).toBe(false);
    expect(snoozeSchema.safeParse({ duration_hours: -1 }).success).toBe(false);
  });
  it("rejeita string em vez de number", () => {
    expect(snoozeSchema.safeParse({ duration_hours: "1" }).success).toBe(false);
  });
});
