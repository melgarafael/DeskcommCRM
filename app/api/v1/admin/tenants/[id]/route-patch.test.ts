/**
 * PATCH /api/v1/admin/tenants/[id] — o admin da plataforma edita o cadastro.
 *
 * Arquivo separado do `route.test.ts` (que mocka `requirePlatformAdmin` inteiro
 * para o GET): aqui a guarda de escrita roda DE VERDADE, e o teste substitui só
 * o que ela consulta — a sessão, a linha de `platform_admins` e a dívida de MFA.
 * Trocar `requirePlatformAdminEscrita` por `requirePlatformAdmin` reprova.
 */
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
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
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
      c.update = (valores: unknown) => (h.updates.push(valores), c);
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
const CADASTRO = {
  display_name: "Acme",
  legal_name: "Acme Ltda",
  cnpj: "12345678000190",
  country: null,
  timezone: "America/Sao_Paulo",
  locale: "pt-BR",
  currency: "BRL",
  media_retention_days: 90,
  media_retention_enforced: false,
};
const pedido = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const admin = (scope: string) => ({ user_id: h.ator, scope, mfa_required: false, revoked_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = admin("full");
  h.mfaEmDivida.mockResolvedValue(false);
  h.erroNoUpdate = null;
  h.updates = [];
});

describe("PATCH /admin/tenants/[id]", () => {
  it("support_readonly: 403 forbidden_scope, nada gravado", async () => {
    h.linhaDoAdmin = admin("support_readonly");
    const res = await PATCH(pedido(CADASTRO), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.updates).toEqual([]);
  });

  it("quem tem fator e está em aal1: 403 mfa_required, nada gravado", async () => {
    h.mfaEmDivida.mockResolvedValue(true);
    const res = await PATCH(pedido(CADASTRO), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("mfa_required");
    expect(h.updates).toEqual([]);
  });

  it("CNPJ de outra organização (23505): 409 com a frase", async () => {
    h.erroNoUpdate = { code: "23505", message: "duplicate key" };
    const res = await PATCH(pedido(CADASTRO), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe("Este CNPJ já pertence a outra organização.");
  });

  it("país sem perfil revisado: 400, nada gravado", async () => {
    const res = await PATCH(pedido({ ...CADASTRO, country: "ZZ" }), ctx);
    expect(res.status).toBe(400);
    expect(h.updates).toEqual([]);
  });

  it("sucesso grava e audita org.updated com via platform_admin", async () => {
    const res = await PATCH(pedido(CADASTRO), ctx);
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    // O interruptor de retenção (0557) vai na gravação compartilhada: sem ele,
    // Configurações › Empresa deixaria de gravá-lo (achado de @Draven9).
    expect(h.updates[0]).toMatchObject({ media_retention_enforced: false });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "org.updated",
      organizationId: TENANT,
      actorUserId: h.ator,
      metadata: { via: "platform_admin" },
    });
  });
});
