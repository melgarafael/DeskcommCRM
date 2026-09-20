import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_PLANS, subscriptionPlan, formatBRL } from "@/lib/billing/plans";

describe("subscription catalogue", () => {
  it("rejects unknown or inherited identifiers", () => {
    expect(subscriptionPlan("constructor")).toBeNull();
    expect(subscriptionPlan("free")).toBeNull();
    expect(subscriptionPlan("crescer")?.monthly_price_cents).toBe(39700);
  });
  it("keeps increasing capacity and a bounded AI allowance", () => {
    SUBSCRIPTION_PLANS.forEach((plan, index) => {
      expect(Number.isInteger(plan.monthly_price_cents)).toBe(true);
      expect(plan.ai_credit_cents).toBeGreaterThan(0);
      expect(plan.ai_credit_cents / plan.monthly_price_cents).toBeLessThan(0.25);
      if (index > 0) {
        const previous = SUBSCRIPTION_PLANS[index - 1]!;
        for (const metric of [
          "seats",
          "channels",
          "agents",
          "ai_credit_cents",
          "monthly_price_cents",
        ] as const) {
          expect(plan[metric]).toBeGreaterThan(previous[metric]);
        }
      }
    });
  });
  it("formats reais without dropping centavos", () => {
    expect(formatBRL(19700)).toMatch(/197$/);
    expect(formatBRL(19750)).toMatch(/197,50$/);
  });
});
