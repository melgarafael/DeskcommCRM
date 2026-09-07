import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  role: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
import { PATCH } from "./route";
const user = "f2210000-0000-4000-8000-000000000001";
const org = "f2210000-0000-4000-8000-000000000002";
const ctx = { params: Promise.resolve({ user_id: user }) };
const request = (settings: unknown = { preset: "simplificada" }) =>
  new NextRequest("http://local/api/v1/team/member/interface", {
    method: "PATCH",
    body: JSON.stringify({ interface_settings: settings }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.support.mockResolvedValue(null);
  mocks.role.mockResolvedValue({ ok: true, user: { id: user }, org: { orgId: org } });
});
it("readonly nega antes de consultar/escrever", async () => {
  mocks.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await PATCH(request(), ctx)).status).toBe(403);
  expect(mocks.role).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
});
it("gate admin nega ao atendente", async () => {
  mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await PATCH(request(), ctx)).status).toBe(403);
  expect(mocks.role).toHaveBeenCalledWith("admin", expect.anything());
  expect(mocks.from).not.toHaveBeenCalled();
});
it("destino arbitrário ou vazio não chega ao banco", async () => {
  for (const destinos of [[], ["/arbitrary"]])
    expect((await PATCH(request({ preset: "completa", destinos }), ctx)).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});
it("membro fora da org não é encontrado nem auditado", async () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  mocks.from.mockReturnValue(chain);
  expect((await PATCH(request(), ctx)).status).toBe(404);
  expect(chain.eq).toHaveBeenCalledWith("organization_id", org);
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("escrita filtra org, membro ativo e papel vigente; emite auditoria", async () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValueOnce({ data: { role: "agent" }, error: null })
      .mockResolvedValueOnce({
        data: { id: user, user_id: user, interface_settings: { preset: "simplificada" } },
        error: null,
      }),
  };
  mocks.from.mockReturnValue(chain);
  expect((await PATCH(request(), ctx)).status).toBe(200);
  expect(chain.eq).toHaveBeenCalledWith("organization_id", org);
  expect(chain.eq).toHaveBeenCalledWith("role", "agent");
  expect(chain.eq).toHaveBeenCalledWith("user_id", user);
  expect(chain.is).toHaveBeenCalledWith("revoked_at", null);
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "team.interface_changed",
      organizationId: org,
      actorUserId: user,
    }),
  );
});
