import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  linhaDoAdmin: null as Record<string, unknown> | null,
  mfaEmDivida: vi.fn(async () => false),
  erroNoUpdate: null as { code?: string; message: string } | null,
  updates: [] as unknown[],
  audit: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDividaEstrita: h.mfaEmDivida }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: h.ator } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: h.linhaDoAdmin, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.maybeSingle = async () => ({ data: { id: TENANT, slug: "acme" }, error: null });
      c.upsert = async (valores: unknown) => {
        h.updates.push(valores);
        return { error: h.erroNoUpdate };
      };
      c.eq = () => c;
      c.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ error: h.erroNoUpdate }).then(resolve);
      return c;
    },
    rpc: () => Promise.resolve({ error: null }),
  }),
}));

import { PATCH } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const CADASTRO = { habilitada: true, limite_clientes: 5 };
const pedido = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/agencia`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const admin = (scope: string) => ({
  user_id: h.ator,
  scope,
  mfa_required: false,
  revoked_at: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = admin("full");
  h.mfaEmDivida.mockResolvedValue(false);
  h.erroNoUpdate = null;
  h.updates = [];
});
describe("configuração de agência só pela plataforma", () => {
  it("recusa pessoa sem administração global antes de escrever", async () => {
    h.linhaDoAdmin = null;
    expect((await PATCH(pedido(CADASTRO), ctx)).status).toBe(403);
    expect(h.updates).toEqual([]);
  });
  it("recusa suporte somente leitura", async () => {
    h.linhaDoAdmin = admin("support_readonly");
    expect((await PATCH(pedido(CADASTRO), ctx)).status).toBe(403);
    expect(h.updates).toEqual([]);
  });
  it("recusa dívida de MFA", async () => {
    h.mfaEmDivida.mockResolvedValue(true);
    expect((await PATCH(pedido(CADASTRO), ctx)).status).toBe(403);
    expect(h.updates).toEqual([]);
  });
  it("recusa tentativa de escolher outra organização pelo corpo", async () => {
    expect((await PATCH(pedido({ ...CADASTRO, organization_id: h.ator }), ctx)).status).toBe(422);
    expect(h.updates).toEqual([]);
  });
  it("grava no alvo do path e audita o ator real", async () => {
    expect((await PATCH(pedido(CADASTRO), ctx)).status).toBe(200);
    expect(h.updates).toEqual([{ organization_id: TENANT, ...CADASTRO }]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: h.ator,
        organizationId: TENANT,
        actingAsPlatformAdmin: true,
      }),
    );
  });
  it("recusa hierarquia inválida sem emitir auditoria de sucesso", async () => {
    h.erroNoUpdate = { code: "23514", message: "agencia_cliente_nao_pode_ser_agencia" };
    expect((await PATCH(pedido(CADASTRO), ctx)).status).toBe(409);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
