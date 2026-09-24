/**
 * GET/POST /api/v1/honorarios/contratos — módulo opcional de advocacia (ADR-0002).
 *
 * Ler exige `viewer`; criar exige `manager` (mesma RLS da migration 0385: dinheiro não é coisa
 * que `agent` configure). Um 42P01 (tabela ausente — módulo não instalado) vira uma mensagem
 * clara, nunca um 500 cru.
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

/** Query builder mínimo: registra os `.eq()` vistos e resolve com o resultado dado. */
function fakeSupabase(resultado: { data: unknown; error: { code?: string } | null }) {
  const filtros: Array<{ coluna: string; valor: unknown }> = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    limit: () => Promise.resolve(resultado),
    eq: (coluna: string, valor: unknown) => {
      filtros.push({ coluna, valor });
      return builder;
    },
    insert: () => builder,
    single: () => Promise.resolve(resultado),
  };
  return { filtros, client: { from: () => builder } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/honorarios/contratos", () => {
  it("viewer autenticado → 200 com a lista", async () => {
    autorizadoComo("viewer");
    const { client } = fakeSupabase({ data: [{ id: "c1", modelo: "fixo" }], error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/honorarios/contratos"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: "c1", modelo: "fixo" }]);
  });

  it("sem role suficiente → repassa o 403 de requireRole", async () => {
    negado();
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/honorarios/contratos"));
    expect(res.status).toBe(403);
  });

  it("módulo não instalado (42P01) → 409 com mensagem clara, não 500", async () => {
    autorizadoComo("viewer");
    const { client } = fakeSupabase({ data: null, error: { code: "42P01" } });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/honorarios/contratos"));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("module_not_installed");
    expect(body.error.message).toMatch(/módulo de honorários não está instalado/);
  });
});

describe("POST /api/v1/honorarios/contratos", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/v1/honorarios/contratos", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("manager cria um contrato de modelo fixo", async () => {
    autorizadoComo("manager");
    const { client } = fakeSupabase({
      data: { id: "c1", modelo: "fixo", valor_fixo_cents: 500000 },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ modelo: "fixo", valor_fixo_cents: 500000 }));

    expect(res.status).toBe(200);
  });

  it("viewer NÃO cria contrato — write exige manager+", async () => {
    negado();
    const { POST } = await import("./route");
    const res = await POST(postReq({ modelo: "fixo", valor_fixo_cents: 500000 }));
    expect(res.status).toBe(403);
  });

  it("modelo êxito sem percentual → 422, nunca chega ao banco", async () => {
    autorizadoComo("manager");
    const { client } = fakeSupabase({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ modelo: "exito" }));

    expect(res.status).toBe(422);
  });
});
