/**
 * GET/POST /api/v1/honorarios/contratos/[id]/parcelas — o calendário de um contrato.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTRATO_ID = "55555555-5555-4555-8555-555555555555";
const params = { params: Promise.resolve({ id: CONTRATO_ID }) };

function usuario(role: "viewer" | "manager"): AuthUser {
  return {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  } as AuthUser;
}

function autorizadoComo(role: "viewer" | "manager"): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(role),
    org: { orgId: ORG_ID, name: "Org", role },
  } as never);
}

function negado(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
  } as never);
}

/**
 * Dublê do PostgREST.
 *
 * `organizations` responde `currency` porque o POST resolve a moeda da parcela
 * no SERVIDOR desde o #3379 (`moedaDaOrganizacao` lê `organizations.currency`
 * com `maybeSingle`). As outras tabelas devolvem o `resultado` do caso — é o
 * mesmo dublê de antes, com a leitura que a rota passou a fazer.
 */
function fakeSupabase(
  resultado: { data: unknown; error: { code?: string } | null },
  moeda = "BRL",
) {
  const builderPara = (tabela: string): Record<string, unknown> => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => Promise.resolve(resultado),
      eq: () => builder,
      insert: () => builder,
      single: () => Promise.resolve(resultado),
      maybeSingle: () =>
        Promise.resolve(
          tabela === "organizations" ? { data: { currency: moeda }, error: null } : resultado,
        ),
    };
    return builder;
  };
  return { from: (tabela: string) => builderPara(tabela) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/honorarios/contratos/[id]/parcelas", () => {
  it("viewer vê as parcelas do contrato", async () => {
    autorizadoComo("viewer");
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ data: [{ id: "p1", numero: 1 }], error: null }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/honorarios/contratos/${CONTRATO_ID}/parcelas`),
      params,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: "p1", numero: 1 }]);
  });
});

describe("POST /api/v1/honorarios/contratos/[id]/parcelas", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest(
      `http://localhost/api/v1/honorarios/contratos/${CONTRATO_ID}/parcelas`,
      { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
    );
  }

  it("manager cria uma parcela válida", async () => {
    autorizadoComo("manager");
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ data: { id: "p1", numero: 1, status: "pendente" }, error: null }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(
      postReq({ numero: 1, vencimento: "2026-10-01", valor_cents: 50000 }),
      params,
    );

    expect(res.status).toBe(200);
  });

  it("viewer não cria parcela", async () => {
    negado();
    const { POST } = await import("./route");
    const res = await POST(
      postReq({ numero: 1, vencimento: "2026-10-01", valor_cents: 50000 }),
      params,
    );
    expect(res.status).toBe(403);
  });

  it("número de parcela repetido (23505) → 422 legível", async () => {
    autorizadoComo("manager");
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ data: null, error: { code: "23505" } }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(
      postReq({ numero: 1, vencimento: "2026-10-01", valor_cents: 50000 }),
      params,
    );

    expect(res.status).toBe(422);
  });

  it("contrato de outra organização (a RLS recusa, 42501) → 422, não 500", async () => {
    autorizadoComo("manager");
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ data: null, error: { code: "42501" } }) as never,
    );

    const { POST } = await import("./route");
    const res = await POST(
      postReq({ numero: 1, vencimento: "2026-10-01", valor_cents: 50000 }),
      params,
    );

    expect(res.status).toBe(422);
  });
});
