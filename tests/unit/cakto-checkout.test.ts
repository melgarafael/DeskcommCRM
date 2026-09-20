import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  pool: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  verify: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: mocks.pool }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/billing/cakto", () => ({
  caktoConfiguration: () => ({ origin: "https://crm.example.test" }),
  caktoCheckoutUrl: (_plan: string, attempt: string) =>
    `https://pay.cakto.com.br/test?sck=escreve_${attempt}`,
  verifyCaktoOffer: mocks.verify,
}));
import { createCaktoCheckout } from "@/lib/billing/cakto-checkout";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BILLING_ENABLED", "true");
  mocks.role.mockResolvedValue({ ok: true, user: { id: org, support: null }, org: { orgId: org } });
  mocks.support.mockResolvedValue(null);
  mocks.pool.mockReturnValue({ connect: mocks.connect });
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.query.mockResolvedValue({ rows: [] });
});
afterEach(() => vi.unstubAllEnvs());
function request(body: unknown = { plan_id: "essencial" }, origin = "https://crm.example.test") {
  return new Request("https://crm.example.test/api/v1/billing/checkout", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify(body),
  });
}
it("uses the authenticated organization and commits before returning a checkout", async () => {
  const response = await createCaktoCheckout(request());
  expect(response.status).toBe(200);
  const write = mocks.query.mock.calls.find(([sql]) => sql.startsWith("insert"));
  expect(write?.[1]).toEqual([
    org,
    "essencial",
    expect.any(String),
    expect.stringContaining("https://pay.cakto.com.br/test?sck=escreve_"),
  ]);
  expect(mocks.query).toHaveBeenCalledWith("commit");
});
it.each(["role", "support", "disabled", "origin", "tenant"])(
  "rejects %s before accessing billing state",
  async (kind) => {
    if (kind === "role")
      mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    if (kind === "support")
      mocks.role.mockResolvedValue({
        ok: true,
        user: { support: { access_mode: "full" } },
        org: { orgId: org },
      });
    if (kind === "disabled") vi.stubEnv("BILLING_ENABLED", "false");
    const response = await createCaktoCheckout(
      request(
        kind === "tenant" ? { plan_id: "essencial", organization_id: org } : undefined,
        kind === "origin" ? "https://attacker.test" : undefined,
      ),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.pool).not.toHaveBeenCalled();
  },
);
it.each(["provider", "subscription", "plan", "missing_attempt"])(
  "does not create a second checkout for %s",
  async (kind) => {
    const current = {
      provider: "cakto",
      provider_subscription_id: kind === "subscription" ? org : null,
      plan_id: kind === "plan" ? "escala" : "essencial",
      checkout_attempt_id: kind === "missing_attempt" ? null : org,
    };
    if (kind === "provider") current.provider = "stripe";
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("select *") ? [current] : [],
    }));
    expect((await createCaktoCheckout(request())).status).toBe(409);
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("insert"))).toBe(false);
  },
);
it("reuses the same pending attempt", async () => {
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith("select *")
      ? [{ provider: "cakto", plan_id: "essencial", checkout_attempt_id: org }]
      : [],
  }));
  const response = await createCaktoCheckout(request());
  expect((await response.json()).data.url).toContain(`escreve_${org}`);
  expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith("insert"))).toBe(false);
});
it.each(["pool", "commit", "provider"])(
  "returns an actionable failure for %s errors",
  async (kind) => {
    if (kind === "pool")
      mocks.pool.mockImplementation(() => {
        throw new Error("configuration");
      });
    if (kind === "provider") mocks.verify.mockRejectedValue(new Error("unavailable"));
    if (kind === "commit")
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql === "commit") throw new Error("offline");
        return { rows: [] };
      });
    expect((await createCaktoCheckout(request())).status).toBe(503);
    expect(mocks.audit).not.toHaveBeenCalled();
  },
);
