import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  orgDoAdmin: "cccccccc-0000-4000-8000-000000000001",
  statusDaOrgDoAdmin: "active",
  rpc: vi.fn(),
}));

// `redirect` do Next lança; num route handler isso vira 307, que o fetch do
// ImpersonateButton segue com `res.ok` true.
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn() }) }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: async () => ({ user: { id: h.ator } }) }));
vi.mock("@/lib/auth/server", async () => {
  const { redirect } = await import("next/navigation");
  const orgAtivaSemPortao = async () => ({ orgId: h.orgDoAdmin, name: "Empresa do admin", role: "admin", org_status: h.statusDaOrgDoAdmin });
  return {
    mfaEmDivida: async () => false,
    loadAuthUser: async () => ({ id: h.ator, support: null, organizations: [] }),
    orgAtivaSemPortao,
    // O porteiro das telas: org parada → /account-suspended.
    resolveActiveOrg: async () => {
      const org = await orgAtivaSemPortao();
      if (org.org_status !== "active") redirect("/account-suspended");
      return org;
    },
  };
});
vi.mock("@/lib/impersonate/cookie", () => ({
  IMPERSONATE_COOKIE_NAME: "impersonate",
  IMPERSONATE_TTL_SECONDS: 3600,
  isImpersonateSecretReady: () => true,
  signImpersonateCookie: () => "assinado",
}));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { session_id: "dddddddd-0000-4000-8000-000000000001" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (...args: unknown[]) => h.rpc(...args),
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.single = async () => ({
        data: { expires_at: "2026-09-30T13:00:00.000Z", access_mode: "full" },
        error: null,
      });
      return c;
    },
  }),
}));

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const pedido = () =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/impersonate`, {
    method: "POST",
    body: JSON.stringify({ access_mode: "full" }),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.statusDaOrgDoAdmin = "active";
  h.rpc.mockResolvedValue({ data: "eeeeeeee-0000-4000-8000-000000000001", error: null });
});

describe("POST /admin/tenants/[id]/impersonate", () => {
  it("com a org ativa do próprio admin SUSPENSA, o acompanhamento abre (200) e p_previous leva o id dela", async () => {
    h.statusDaOrgDoAdmin = "suspended";
    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("fn_start_support", expect.objectContaining({ p_org: TENANT, p_previous: h.orgDoAdmin }));
  });

  it("controle: com a org do admin ativa, o mesmo caminho", async () => {
    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("fn_start_support", expect.objectContaining({ p_previous: h.orgDoAdmin }));
  });
});
