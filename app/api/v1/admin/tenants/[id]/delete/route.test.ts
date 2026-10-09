/**
 * POST /api/v1/admin/tenants/[id]/delete — a rota só autoriza e traduz; o
 * procedimento é de `lib/tenants/exclusao.ts` (testado lá). Aqui: a guarda de
 * escrita roda de verdade (só o que ela consulta é substituído) e a recusa por
 * cobrança chega a quem chamou como 409 com o próprio código.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhaDoAdmin: null as Record<string, unknown> | null,
  excluir: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "aaaaaaaa-0000-4000-8000-000000000001" } } }),
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
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/tenants/exclusao", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  excluirOrganizacao: h.excluir,
}));

import { ExclusaoInterrompida, ExclusaoRecusada } from "@/lib/tenants/exclusao";

import { POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: TENANT }) };
const pedido = () =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/delete`, {
    method: "POST",
    body: JSON.stringify({ confirmacao: "acme", motivo: "contrato encerrado pelo cliente" }),
    headers: { "content-type": "application/json" },
  });
const admin = (scope: string) => ({
  user_id: "aaaaaaaa-0000-4000-8000-000000000001",
  scope,
  mfa_required: false,
  revoked_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = admin("full");
});

describe("POST /admin/tenants/[id]/delete", () => {
  it("suspensão por cobrança: 409 exclusao_com_cobranca_pendente", async () => {
    h.excluir.mockRejectedValue(
      new ExclusaoRecusada("exclusao_com_cobranca_pendente", "Esta empresa está suspensa por falta de pagamento."),
    );
    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("exclusao_com_cobranca_pendente");
  });

  it("interrompida depois do commit: 500 que NÃO diz 'nada foi apagado' e manda tentar de novo", async () => {
    h.excluir.mockRejectedValue(new ExclusaoInterrompida("exclusao_banco_sem_resposta: fetch failed"));
    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(500);
    const msg = (await res.json()).error.message as string;
    expect(msg).not.toMatch(/nada foi apagado/i);
    expect(msg).toMatch(/tente de novo/i);
  });

  it("erro antes do commit: 500 que diz que nada foi apagado", async () => {
    h.excluir.mockRejectedValue(new Error("exclusao_banco: organizacao_exclusao_incompleta"));
    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toMatch(/nada foi apagado/i);
  });

  it("acesso de suporte (support_readonly): 403 forbidden_scope, a exclusão nem começa", async () => {
    h.linhaDoAdmin = admin("support_readonly");
    const res = await POST(pedido(), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.excluir).not.toHaveBeenCalled();
  });
});
