import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ auth: vi.fn(), support: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: m.auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: m.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: m.query }),
}));
import { GET, POST } from "@/app/api/v1/admin/billing/reconciliation/route";
const actor = "11111111-1111-4111-8111-111111111111",
  org = "22222222-2222-4222-8222-222222222222",
  reservation = "33333333-3333-4333-8333-333333333333";
const body = {
  reservation_id: reservation,
  cost_usd_cents: 1.25,
  reference: "Provider report resp_test",
  verified: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: actor }, platformAdmin: { scope: "full" } });
  m.support.mockResolvedValue(null);
  m.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("fn_reconcile")
      ? [{ charged_brl_cents: "7.5" }]
      : [{ organization_id: org }],
  }));
});
const request = (data: unknown = body) =>
  new NextRequest("http://localhost/api/v1/admin/billing/reconciliation", {
    method: "POST",
    body: JSON.stringify(data),
  });
it("uses only the stored organization and authenticated actor", async () => {
  const result = await POST(request());
  expect(result.status).toBe(200);
  expect(m.query).toHaveBeenLastCalledWith(
    expect.stringContaining("fn_reconcile_subscription_ai"),
    [org, reservation, actor, 1.25, body.reference, expect.any(String)],
  );
  expect(await result.json()).toMatchObject({ data: { charged_brl_cents: "7.5" } });
});
it.each([
  { ...body, organization_id: org },
  { ...body, verified: false },
  { ...body, cost_usd_cents: -1 },
  { ...body, reference: "short" },
])("rejects unverified or tampered accounting input", async (input) => {
  expect((await POST(request(input))).status).toBe(400);
  expect(m.query).not.toHaveBeenCalled();
});
it("denies non-admin, readonly and restricted-support writes before database access", async () => {
  m.auth.mockRejectedValueOnce(new Error("denied"));
  expect((await POST(request())).status).toBe(403);
  m.auth.mockResolvedValueOnce({
    user: { id: actor },
    platformAdmin: { scope: "support_readonly" },
  });
  expect((await POST(request())).status).toBe(403);
  m.support.mockResolvedValueOnce(new Response(null, { status: 403 }));
  expect((await POST(request())).status).toBe(403);
  expect(m.query).not.toHaveBeenCalled();
});
it("returns recoverable errors without leaking database details", async () => {
  m.query.mockRejectedValueOnce(new Error("secret database connection"));
  const result = await POST(request());
  expect(result.status).toBe(503);
  expect(JSON.stringify(await result.json())).not.toContain("secret");
});
it("refuses stale settlement instead of confirming a second charge", async () => {
  m.query
    .mockResolvedValueOnce({ rows: [{ organization_id: org }] })
    .mockRejectedValueOnce({ code: "P4022" });
  expect((await POST(request())).status).toBe(409);
});
it("lists only through the platform guard and validates its cursor", async () => {
  m.auth.mockRejectedValueOnce(new Error("denied"));
  expect(
    (await GET(new NextRequest("http://localhost/api/v1/admin/billing/reconciliation"))).status,
  ).toBe(403);
  expect(
    (
      await GET(
        new NextRequest("http://localhost/api/v1/admin/billing/reconciliation?after=invalid"),
      )
    ).status,
  ).toBe(400);
  expect(m.query).not.toHaveBeenCalled();
  m.query.mockResolvedValue({ rows: Array.from({ length: 51 }, (_, n) => ({ id: String(n) })) });
  const result = await GET(new NextRequest("http://localhost/api/v1/admin/billing/reconciliation"));
  const data = (await result.json()).data;
  expect(data.items).toHaveLength(50);
  expect(data.next_cursor).toBe("49");
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("r.status='unknown'"), [null]);
});
