import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  config: vi.fn(),
  connect: vi.fn(),
  signature: vi.fn(),
  checkout: vi.fn(),
  subscription: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: mocks.connect }),
}));
vi.mock("@/lib/billing/stripe", () => ({
  billingConfiguration: mocks.config,
  createStripeCheckout: mocks.checkout,
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
