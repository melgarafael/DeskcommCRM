import { describe, expect, it } from "vitest";
import { subscriptionView, type SubscriptionSnapshot } from "@/lib/billing/subscription-view";
const now = Date.parse("2026-09-20T12:00:00Z");
function snapshot(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    provider: "stripe",
    provider_customer_id: "cus_example",
    provider_subscription_id: "sub_example",
    plan_id: "essencial",
    status: "active",
    current_period_end: "2026-10-20T12:00:00Z",
    checkout_session_id: "cs_example",
    checkout_expires_at: "2026-09-19T12:00:00Z",
    ...overrides,
  };
}
describe("billing display uses authoritative subscription state", () => {
  it("allows a legacy company to choose a plan without claiming a subscription", () => {
    const view = subscriptionView(undefined, now);
    expect(view.active).toBe(false);
    expect(view.allowedPlanIds).toEqual(["essencial", "crescer", "escala"]);
    expect(view.canManage).toBe(false);
  });
  it("never confirms activation from a checkout session", () => {
    const view = subscriptionView(
      snapshot({ provider_subscription_id: null, checkout_expires_at: "2026-09-21T12:00:00Z" }),
      now,
    );
    expect(view.active).toBe(false);
    expect(view.message).toContain("não foi confirmado");
    expect(view.allowedPlanIds).toEqual(["essencial"]);
  });
  it("keeps an ambiguous attempt bound to its original plan", () => {
    expect(
      subscriptionView(snapshot({ provider_subscription_id: null, checkout_session_id: null }), now)
        .allowedPlanIds,
    ).toEqual(["essencial"]);
  });
  it("offers management, never duplicate checkout, for a confirmed subscription", () => {
    expect(subscriptionView(snapshot(), now)).toMatchObject({
      active: true,
      allowedPlanIds: [],
      canManage: true,
    });
  });
  it.each(["past_due", "unpaid", "incomplete", "paused"])(
    "does not offer duplicate checkout for %s",
    (status) => {
      const view = subscriptionView(snapshot({ status }), now);
      expect(view.allowedPlanIds).toEqual([]);
      expect(view.active).toBe(false);
      expect(view.message).toContain("atenção");
    },
  );
  it("does not call an expired confirmed period active", () => {
    expect(
      subscriptionView(snapshot({ current_period_end: "2026-09-19T12:00:00Z" }), now).active,
    ).toBe(false);
  });
  it("allows a replacement after a terminal subscription", () => {
    expect(subscriptionView(snapshot({ status: "canceled" }), now).allowedPlanIds).toHaveLength(3);
  });
  it("keeps an open replacement checkout on its selected plan", () => {
    expect(
      subscriptionView(
        snapshot({ status: "canceled", checkout_expires_at: "2026-09-21T12:00:00Z" }),
        now,
      ).allowedPlanIds,
    ).toEqual(["essencial"]);
  });
});
it("allows recovery of a pending replacement without presenting the former subscription as active", () => {
  const view = subscriptionView(snapshot({ status: "pending", checkout_session_id: null }), now);
  expect(view.active).toBe(false);
  expect(view.allowedPlanIds).toEqual(["essencial"]);
  expect(view.message).toContain("não foi confirmado");
});
it("keeps a pending Cakto link on its selected plan even without an expiry", () => {
  const view = subscriptionView(
    snapshot({
      provider: "cakto",
      provider_subscription_id: null,
      checkout_expires_at: null,
      status: "pending",
    }),
    now,
  );
  expect(view.allowedPlanIds).toEqual(["essencial"]);
  expect(view.active).toBe(false);
  expect(view.canManage).toBe(false);
});
it.each(["pending", "canceled", "unpaid", "active"])(
  "never offers duplicate Cakto checkout when bound: %s",
  (status) => {
    const view = subscriptionView(snapshot({ provider: "cakto", status }), now);
    expect(view.allowedPlanIds).toEqual([]);
    expect(view.caktoBound).toBe(true);
    expect(view.canManage).toBe(false);
  },
);
it("explains a canceled renewal without hiding the paid period", () => {
  const view = subscriptionView(snapshot({ provider: "cakto", cancel_at_period_end: true }), now);
  expect(view.active).toBe(true);
  expect(view.message).toContain("Renovação cancelada");
});
