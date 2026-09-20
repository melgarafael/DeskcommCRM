import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  poolQuery: vi.fn(),
  portal: vi.fn(),
  role: vi.fn(),
  support: vi.fn(),
  config: vi.fn(),
  connect: vi.fn(),
  signature: vi.fn(),
  checkout: vi.fn(),
  retrieveCheckout: vi.fn(),
  subscription: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: mocks.connect, query: mocks.poolQuery }),
}));
vi.mock("@/lib/billing/stripe", () => ({
  billingConfiguration: mocks.config,
  createStripeCheckout: mocks.checkout,
  retrieveStripeCheckout: mocks.retrieveCheckout,
  createStripePortal: mocks.portal,
  retrieveStripeSubscription: mocks.subscription,
  verifyStripeSignature: mocks.signature,
  BillingUnavailable: class extends Error {
    constructor() {
      super("Cobrança indisponível.");
    }
  },
}));
import { POST as checkout } from "@/app/api/v1/billing/checkout/route";
import { POST as webhook } from "@/app/api/v1/billing/webhook/route";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockResolvedValue({
    ok: true,
    user: { support: null },
    org: { orgId: "trusted-org" },
  });
  mocks.support.mockResolvedValue(null);
  mocks.config.mockReturnValue({
    origin: "https://crm.example.test",
    webhook: "test-only",
    live: false,
  });
  mocks.signature.mockReturnValue(true);
});
function request(body: unknown, origin = "https://crm.example.test") {
  return new Request(`${origin}/api/v1/billing/checkout`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
it("returns the role denial without any database or provider side effects", async () => {
  mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(403);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it("rejects even full-access support impersonation from purchasing", async () => {
  mocks.role.mockResolvedValue({
    ok: true,
    user: { support: { access_mode: "full" } },
    org: { orgId: "trusted-org" },
  });
  expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(403);
  expect(mocks.connect).not.toHaveBeenCalled();
});
it("disabled billing never reaches the database in either endpoint", async () => {
  mocks.config.mockImplementation(() => {
    throw new Error("disabled");
  });
  expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(503);
  expect((await webhook(request({}))).status).toBe(503);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it("rejects cross-origin checkout before reading subscription state", async () => {
  expect(
    (await checkout(request({ plan_id: "essencial" }, "https://other.example.test"))).status,
  ).toBe(403);
  expect(mocks.connect).not.toHaveBeenCalled();
});
it.each([
  { plan_id: "unknown" },
  { plan_id: "essencial", organization_id: "attacker" },
  { plan_id: "essencial", amount: 1 },
])("rejects unknown plans or client-controlled billing fields: %j", async (body) => {
  expect((await checkout(request(body))).status).toBe(400);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it("unsigned webhooks cannot access the database or retrieve subscriptions", async () => {
  mocks.signature.mockReturnValue(false);
  expect((await webhook(request({ id: "evt_test" }))).status).toBe(401);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.subscription).not.toHaveBeenCalled();
});
it("rejects live events when the configured provider is in test mode", async () => {
  expect(
    (
      await webhook(
        request({
          id: "evt_test",
          type: "customer.subscription.updated",
          livemode: true,
          data: { object: { id: "sub_test" } },
        }),
      )
    ).status,
  ).toBe(400);
  expect(mocks.connect).not.toHaveBeenCalled();
});
it("acknowledges unrelated signed events without side effects", async () => {
  expect(
    (
      await webhook(
        request({
          id: "evt_test",
          type: "customer.created",
          livemode: false,
          data: { object: { id: "cus_test" } },
        }),
      )
    ).status,
  ).toBe(200);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.subscription).not.toHaveBeenCalled();
});

const attempt = "11111111-1111-4111-8111-111111111111";
const previousAttempt = "22222222-2222-4222-8222-222222222222";
function eventRequest() {
  return request({
    id: "evt_update",
    type: "customer.subscription.updated",
    livemode: false,
    data: { object: { id: "sub_current" } },
  });
}
function webhookFixture(overrides: Record<string, unknown> = {}) {
  const row = {
    provider: "stripe",
    provider_customer_id: "cus_company",
    provider_subscription_id: "sub_current",
    status: "active",
    plan_id: "essencial",
    checkout_attempt_id: attempt,
    ...overrides,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("select * from org_subscriptions")) return { rows: [row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  mocks.connect.mockResolvedValue({ query, release });
  mocks.subscription.mockResolvedValue({
    id: "sub_current",
    customer: "cus_company",
    metadata: {
      organization_id: "trusted-org",
      plan_id: "essencial",
      checkout_attempt_id: attempt,
    },
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ current_period_start: 1797408000, current_period_end: 1800000000 }] },
  });
  return { row, query, release };
}
it("uses current provider state instead of trusting the event snapshot", async () => {
  const { query, release } = webhookFixture();
  const result = await webhook(eventRequest());
  expect(result.status).toBe(200);
  expect(mocks.subscription).toHaveBeenCalledWith("sub_current");
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("current_period_start=to_timestamp($8)"),
    [
      "trusted-org",
      "essencial",
      "cus_company",
      "sub_current",
      "active",
      1800000000,
      false,
      1797408000,
    ],
  );
  expect(query.mock.calls.some(([sql]) => sql.startsWith("update org_subscriptions"))).toBe(true);
  expect(query.mock.calls.some(([sql]) => sql.includes("insert into billing_webhook_events"))).toBe(
    true,
  );
  expect(release).toHaveBeenCalledOnce();
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "billing.subscription_synced",
      organizationId: "trusted-org",
    }),
  );
});
it.each(["active", "pending", "canceled", "incomplete_expired"])(
  "an obsolete checkout cannot replace a %s subscription",
  async (status) => {
    const { query } = webhookFixture({ status });
    const sub = await mocks.subscription();
    sub.metadata.checkout_attempt_id = previousAttempt;
    mocks.subscription.mockResolvedValue(sub);
    const result = await webhook(eventRequest());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data: { ignored: true } });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("update org_subscriptions"))).toBe(
      false,
    );
  },
);
it("rejects a plan different from the persisted checkout selection", async () => {
  const { query } = webhookFixture({ plan_id: "crescer" });
  expect((await webhook(eventRequest())).status).toBe(503);
  expect(query.mock.calls.some(([sql]) => sql.startsWith("update org_subscriptions"))).toBe(false);
});
it("a duplicate event never re-fetches or rewrites the subscription", async () => {
  const { query } = webhookFixture();
  query.mockImplementation(async (sql: string) => ({
    rows: [],
    rowCount: sql.includes("select 1 from billing_webhook_events") ? 1 : 0,
  }));
  expect((await webhook(eventRequest())).status).toBe(200);
  expect(mocks.subscription).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(query.mock.calls.some(([sql]) => sql.startsWith("update org_subscriptions"))).toBe(false);
});
it("returns a recoverable response when no database connection is available", async () => {
  mocks.connect.mockRejectedValue(new Error("database unavailable"));
  expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(503);
  expect((await webhook(eventRequest())).status).toBe(503);
  expect(mocks.checkout).not.toHaveBeenCalled();
  expect(mocks.subscription).not.toHaveBeenCalled();
});

it("does not replay an ambiguous checkout after the provider idempotency window", async () => {
  webhookFixture({
    provider_subscription_id: null,
    status: "pending",
    checkout_session_id: null,
    updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });
  expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(409);
  expect(mocks.checkout).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("retries a recent ambiguous checkout with the same persisted attempt", async () => {
  webhookFixture({
    provider_subscription_id: null,
    status: "pending",
    checkout_session_id: null,
    updated_at: new Date().toISOString(),
  });
  mocks.checkout.mockRejectedValue(new Error("provider timeout"));
  expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(503);
  expect(mocks.checkout).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: "trusted-org",
      attemptId: attempt,
      planId: "essencial",
    }),
  );
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("a canceled subscription gets a fresh attempt even when the prior session was not persisted", async () => {
  webhookFixture({
    status: "canceled",
    checkout_session_id: null,
    updated_at: new Date(0).toISOString(),
  });
  mocks.checkout.mockResolvedValue({
    id: "cs_new",
    url: "https://checkout.stripe.com/test",
    expires_at: 1900000000,
  });
  expect((await checkout(request({ plan_id: "crescer" }))).status).toBe(200);
  expect(mocks.checkout).toHaveBeenCalledWith(
    expect.objectContaining({ planId: "crescer", attemptId: expect.not.stringMatching(attempt) }),
  );
});

import { POST as portal } from "@/app/api/v1/billing/portal/route";
it("portal resolves the customer from the authenticated company", async () => {
  mocks.poolQuery.mockResolvedValue({
    rows: [{ provider: "stripe", provider_customer_id: "cus_own" }],
  });
  mocks.portal.mockResolvedValue({ url: "https://billing.stripe.com/session" });
  expect((await portal(request({}))).status).toBe(200);
  expect(mocks.poolQuery).toHaveBeenCalledWith(expect.any(String), ["trusted-org"]);
  expect(mocks.portal).toHaveBeenCalledWith("cus_own");
});
it.each([
  { customer_id: "cus_other" },
  { organization_id: "other" },
  { return_url: "https://evil.example" },
])("portal refuses client-controlled identity or redirect: %j", async (body) => {
  expect((await portal(request(body))).status).toBe(400);
  expect(mocks.poolQuery).not.toHaveBeenCalled();
  expect(mocks.portal).not.toHaveBeenCalled();
});
it("portal cannot open without a bound customer", async () => {
  mocks.poolQuery.mockResolvedValue({ rows: [] });
  expect((await portal(request({}))).status).toBe(409);
  expect(mocks.portal).not.toHaveBeenCalled();
});
it("portal remains unavailable while billing is disabled", async () => {
  mocks.config.mockImplementation(() => {
    throw new Error("disabled");
  });
  expect((await portal(request({}))).status).toBe(503);
  expect(mocks.poolQuery).not.toHaveBeenCalled();
});
it("portal rejects support impersonation even with full access", async () => {
  mocks.role.mockResolvedValue({
    ok: true,
    user: { support: { access_mode: "full" } },
    org: { orgId: "trusted-org" },
  });
  expect((await portal(request({}))).status).toBe(403);
  expect(mocks.poolQuery).not.toHaveBeenCalled();
});
it("portal failure does not report a successful opening", async () => {
  mocks.poolQuery.mockRejectedValue(new Error("database unavailable"));
  expect((await portal(request({}))).status).toBe(503);
  expect(mocks.audit).not.toHaveBeenCalled();
});

it.each([new Date(0).toISOString(), new Date(Date.now() + 3600000).toISOString()])(
  "a completed checkout cannot create another subscription regardless of local expiry %s",
  async (checkout_expires_at) => {
    const { query } = webhookFixture({
      provider_subscription_id: null,
      status: "pending",
      checkout_session_id: "cs_previous",
      checkout_url: "https://checkout.stripe.com/old",
      checkout_expires_at,
    });
    mocks.retrieveCheckout.mockResolvedValue({ status: "complete", subscription: "sub_waiting" });
    expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(409);
    expect(mocks.retrieveCheckout).toHaveBeenCalledWith({
      sessionId: "cs_previous",
      organizationId: "trusted-org",
      attemptId: attempt,
      planId: "essencial",
      customerId: "cus_company",
    });
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.startsWith("update org_subscriptions"))).toBe(
      false,
    );
  },
);
it("reuses the provider's still-open session even after local expiry", async () => {
  webhookFixture({
    provider_subscription_id: null,
    status: "pending",
    checkout_session_id: "cs_previous",
    checkout_expires_at: new Date(0).toISOString(),
  });
  mocks.retrieveCheckout.mockResolvedValue({
    status: "open",
    subscription: null,
    url: "https://checkout.stripe.com/canonical",
  });
  const response = await checkout(request({ plan_id: "essencial" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { url: "https://checkout.stripe.com/canonical" },
  });
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it("a verified expired session allows a fresh attempt", async () => {
  webhookFixture({
    provider_subscription_id: null,
    status: "pending",
    checkout_session_id: "cs_old",
  });
  mocks.retrieveCheckout.mockResolvedValue({ status: "expired", subscription: null });
  mocks.checkout.mockResolvedValue({
    id: "cs_new",
    url: "https://checkout.stripe.com/new",
    expires_at: 1900000000,
  });
  expect((await checkout(request({ plan_id: "crescer" }))).status).toBe(200);
  expect(mocks.checkout).toHaveBeenCalledWith(
    expect.objectContaining({
      planId: "crescer",
      attemptId: expect.not.stringMatching(attempt),
    }),
  );
});
it("provider lookup failure preserves the attempt and never creates another payment", async () => {
  const { query } = webhookFixture({
    provider_subscription_id: null,
    status: "pending",
    checkout_session_id: "cs_old",
  });
  mocks.retrieveCheckout.mockRejectedValue(new Error("timeout"));
  expect((await checkout(request({ plan_id: "essencial" }))).status).toBe(503);
  expect(mocks.checkout).not.toHaveBeenCalled();
  expect(query.mock.calls.some(([sql]) => sql.startsWith("update org_subscriptions"))).toBe(false);
});
it("a completed session for the already canceled subscription permits replacement", async () => {
  webhookFixture({ status: "canceled", checkout_session_id: "cs_old" });
  mocks.retrieveCheckout.mockResolvedValue({ status: "complete", subscription: "sub_current" });
  mocks.checkout.mockResolvedValue({
    id: "cs_new",
    url: "https://checkout.stripe.com/new",
    expires_at: 1900000000,
  });
  expect((await checkout(request({ plan_id: "crescer" }))).status).toBe(200);
});
it("a different completed subscription cannot use the canceled replacement exception", async () => {
  webhookFixture({ status: "canceled", checkout_session_id: "cs_old" });
  mocks.retrieveCheckout.mockResolvedValue({ status: "complete", subscription: "sub_other" });
  expect((await checkout(request({ plan_id: "crescer" }))).status).toBe(409);
  expect(mocks.checkout).not.toHaveBeenCalled();
});

it("a replacement timeout retries the same attempt while retaining the old subscription binding", async () => {
  const row: Record<string, unknown> = {
    provider: "stripe",
    provider_customer_id: "cus_company",
    provider_subscription_id: "sub_current",
    status: "canceled",
    plan_id: "essencial",
    checkout_session_id: null,
    checkout_attempt_id: attempt,
    updated_at: new Date(0).toISOString(),
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("select * from org_subscriptions"))
      return { rows: [{ ...row }], rowCount: 1 };
    if (sql.startsWith("update org_subscriptions set plan_id=")) {
      // Mirror only the persisted columns the real statement changes.
      expect(sql).toContain("status='pending'");
      expect(sql).not.toContain("provider_subscription_id=null");
      row.plan_id = values![1];
      row.checkout_attempt_id = values![2];
      row.status = "pending";
      row.updated_at = new Date().toISOString();
    }
    return { rows: [], rowCount: 0 };
  });
  mocks.connect.mockResolvedValue({ query, release: vi.fn() });
  mocks.checkout.mockRejectedValue(new Error("ambiguous timeout"));
  expect((await checkout(request({ plan_id: "crescer" }))).status).toBe(503);
  expect(row.provider_subscription_id).toBe("sub_current");
  expect((await checkout(request({ plan_id: "crescer" }))).status).toBe(503);
  expect(mocks.checkout).toHaveBeenCalledTimes(2);
  const first = mocks.checkout.mock.calls[0]![0];
  expect(first.attemptId).not.toBe(attempt);
  expect(mocks.checkout.mock.calls[1]![0]).toEqual(first);
});
it("a pending replacement accepts its new subscription only with the persisted attempt", async () => {
  const { query } = webhookFixture({ status: "pending", provider_subscription_id: "sub_old" });
  expect((await webhook(eventRequest())).status).toBe(200);
  expect(query.mock.calls.some(([sql]) => sql.startsWith("update org_subscriptions"))).toBe(true);
});
