import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

const estado = vi.hoisted(() => ({ podeControlar: false, efeito: vi.fn(), auditoria: vi.fn() }));
const ORG = "25420000-0000-4000-8000-000000000001";
const ID = "25420000-4444-4000-8000-000000000001";
const DONO = "25420000-1111-4000-8000-000000000001";
const COLEGA = "25420000-1111-4000-8000-000000000002";
const conversa = { id: ID, organization_id: ORG, assigned_to_user_id: DONO, service_revision: 1, contacts: { is_personal: false } };

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: estado.auditoria }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async () => ({ ok: true, user: { id: COLEGA, idioma: "pt-BR" }, org: { orgId: ORG, role: "agent" } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: estado.efeito }) }));

function sessao() {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: conversa, error: null }) };
  return { from: () => q, rpc: async () => ({ data: estado.podeControlar, error: null }) } as unknown as SupabaseClient;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessao() }));

import { POST } from "@/app/api/v1/conversations/[id]/close/route";
import { patchConversationHandler } from "@/app/api/v1/conversations/_handler";

beforeEach(() => {
  estado.podeControlar = false;
  vi.clearAllMocks();
  estado.efeito.mockResolvedValue({ data: conversa, error: null });
});

describe("convite não amplia a autoridade de fechar ou mudar status (#2542)", () => {
  it("POST /close recusa a convidada antes do efeito service role", async () => {
    const resposta = await POST(new NextRequest(`http://localhost/api/v1/conversations/${ID}/close`, { method: "POST" }), { params: Promise.resolve({ id: ID }) });
    expect(resposta.status).toBe(403);
    expect(estado.efeito).not.toHaveBeenCalled();
    expect(estado.auditoria).not.toHaveBeenCalled();
  });

  it("PATCH de status recusa a mesma convidada antes do efeito service role", async () => {
    await expect(patchConversationHandler(sessao(), { organization_id: ORG, actor: { type: "user", id: COLEGA }, requestId: "teste" }, ID, { status: "closed" })).rejects.toMatchObject({ status: 403 });
    expect(estado.efeito).not.toHaveBeenCalled();
  });

  it("preserva o controle anterior de quem já tinha escopo, mesmo sem ser o dono", async () => {
    estado.podeControlar = true;
    const resposta = await POST(new NextRequest(`http://localhost/api/v1/conversations/${ID}/close`, { method: "POST" }), { params: Promise.resolve({ id: ID }) });
    expect(resposta.status).toBe(200);
    expect(estado.efeito).toHaveBeenCalledOnce();
  });
});
