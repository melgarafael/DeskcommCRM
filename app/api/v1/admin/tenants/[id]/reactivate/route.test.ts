import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  linhaDoAdmin: null as Record<string, unknown> | null,
  org: null as Record<string, unknown> | null,
  escritasDiretas: [] as string[],
  rpc: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: h.ator } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
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
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({ data: h.org, error: null });
      c.insert = () => (h.escritasDiretas.push(tabela), c);
      c.update = () => (h.escritasDiretas.push(tabela), c);
      return c;
    },
    rpc: (...args: unknown[]) => h.rpc(...args),
  }),
}));

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const MOTIVO = "Fraude descartada depois da análise do caso";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const pedido = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/reactivate`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
const admin = (scope: string) => ({ user_id: h.ator, scope, mfa_required: false, revoked_at: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = admin("full");
  h.org = { id: TENANT, slug: "acme", status: "suspended", suspended_kind: "administrativa" };
  h.escritasDiretas = [];
  h.rpc.mockResolvedValue({ data: { changed: true }, error: null });
});

describe("POST /admin/tenants/[id]/reactivate", () => {
  it("suspensão por COBRANÇA → 409 suspensao_de_cobranca, sem chamar a função", async () => {
    h.org = { id: TENANT, slug: "acme", status: "suspended", suspended_kind: "cobranca" };
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("suspensao_de_cobranca");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("org REDIGIDA com tipo residual 'cobranca' → não é 409 de cobrança (a função responde)", async () => {
    // O lgpd-redact-worker troca status para 'redacted' sem limpar o tipo:
    // parada, mas não suspensa — negociar pagamento seria instrução errada.
    h.org = { id: TENANT, slug: "acme", status: "redacted", suspended_kind: "cobranca" };
    h.rpc.mockResolvedValue({ data: { changed: false, motivo: "nao_suspensa" }, error: null });
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it("administrativa reativa pela função com kind exigido e audita com o motivo", async () => {
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("fn_reativar_organizacao", {
      p_org: TENANT, p_kind_exigido: "administrativa", p_ator: h.ator,
    });
    expect(h.escritasDiretas).toEqual([]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({ action: "tenant.reactivated", metadata: { reason: MOTIVO } });
  });

  it("support_readonly → 403 forbidden_scope, nada chamado", async () => {
    h.linhaDoAdmin = admin("support_readonly");
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("changed:false (não estava suspensa) → 200 sem audit", async () => {
    h.rpc.mockResolvedValue({ data: { changed: false, motivo: "nao_suspensa" }, error: null });
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect((await res.json()).data).toEqual({ changed: false, motivo: "nao_suspensa" });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("motivo curto → 400; tenant inexistente → 404; erro da função → 500", async () => {
    expect((await POST(pedido({ reason: "curto" }), ctx)).status).toBe(400);
    h.org = null;
    expect((await POST(pedido({ reason: MOTIVO }), ctx)).status).toBe(404);
    h.org = { id: TENANT, slug: "acme", status: "suspended", suspended_kind: "administrativa" };
    h.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await POST(pedido({ reason: MOTIVO }), ctx)).status).toBe(500);
  });

  it("trava do aviso do Meet (40001 appointment_notice_busy) → 409 retry_later, sem audit", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "appointment_notice_busy" } });
    const res = await POST(pedido({ reason: MOTIVO }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      code: "retry_later",
      message: "Outra operação está em andamento para esta empresa. Tente de novo em instantes.",
    });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
