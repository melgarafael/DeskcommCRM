import { test, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: true,
  admin: true,
  write: true,
  org: "trusted-cookie-org",
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    m.role
      ? { ok: true, org: { orgId: m.org } }
      : { ok: false, response: new Response("{}", { status: 403 }) },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/ai/inbox-destino", () => ({ PAPEL_MINIMO_DA_CENTRAL: "agent" }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: async () => {
    if (!m.admin) throw Error("denied");
  },
  requirePlatformAdminEscrita: async () => {
    if (!m.write) throw Error("denied");
  },
  falhaDaEscritaDePlatformAdmin: () => new Response("{}", { status: 403 }),
}));
import * as central from "@/app/api/v1/ai/inbox/episodes/route";
import * as admin from "@/app/api/v1/admin/notices/episodes/route";
const items = [{ id: "00000000-0000-4000-8000-000000000001", revision: "a".repeat(64) }];
beforeEach(() => {
  vi.clearAllMocks();
  m.role = true;
  m.admin = true;
  m.write = true;
  m.rpc.mockResolvedValue({ data: { items: [], has_more: false }, error: null });
});
test("Central organization comes only from trusted guard, never a request parameter", async () => {
  expect((await central.GET()).status).toBe(200);
  expect(m.rpc.mock.calls[0]).toEqual([
    "fn_notice_episode_page",
    { p_organization_id: m.org, p_limit: 20 },
  ]);
  const bad = await central.POST(
    new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ items, organization_id: "attacker" }),
    }),
  );
  expect(bad.status).toBe(422);
  expect(m.rpc).toHaveBeenCalledOnce();
});
test("receipt accepts strict id/revision and preserves trusted organization", async () => {
  const r = await central.POST(
    new Request("http://localhost/test", { method: "POST", body: JSON.stringify({ items }) }),
  );
  expect(r.status).toBe(200);
  expect(m.rpc.mock.calls[0]).toEqual([
    "fn_notice_episode_ack",
    { p_organization_id: m.org, p_items: items },
  ]);
});
test("denied guards do not call RPC", async () => {
  m.role = false;
  expect((await central.GET()).status).toBe(403);
  m.admin = false;
  expect((await admin.GET()).status).toBe(403);
  m.write = false;
  expect((await admin.POST(new Request("http://localhost", { method: "POST" }))).status).toBe(403);
  expect(m.rpc).not.toHaveBeenCalled();
});
test("RPC revocation/error never forwards database details or stale data", async () => {
  m.rpc.mockResolvedValue({
    data: { items: [{ title: "stale-private" }] },
    error: { code: "PT401", message: "private" },
  });
  const r = await admin.GET();
  expect(r.status).toBe(401);
  const body = await r.text();
  expect(body).not.toContain("stale-private");
  expect(body).not.toContain("private");
});
