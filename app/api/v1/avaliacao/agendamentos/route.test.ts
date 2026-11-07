/**
 * GET/POST /api/v1/avaliacao/agendamentos — módulo opcional `avaliacao` (ADR-0002).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/avaliacao/resolver-contato", () => ({
  resolverContatoParaAgendamento: vi.fn(async () => ({ contact_id: "cccccccc-3333-4000-8000-000000000001" })),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function usuario(role: "viewer" | "agent"): AuthUser {
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

function autorizadoComo(role: "viewer" | "agent"): void {
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

function fakeSupabase(resultado: { data: unknown; error: { code?: string; message?: string } | null }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    limit: () => Promise.resolve(resultado),
    gte: () => builder,
    lte: () => builder,
    eq: () => builder,
    insert: () => builder,
    single: () => Promise.resolve(resultado),
  };
  return { client: { from: () => builder, rpc: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAdminClient).mockReturnValue({} as never);
  vi.mocked(moduloLigado).mockResolvedValue(true);
});

describe("GET /api/v1/avaliacao/agendamentos", () => {
  it("módulo desligado → 404", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/avaliacao/agendamentos?de=2026-01-01T00:00:00.000Z&ate=2026-01-07T23:59:59.999Z",
      ),
    );
    expect(res.status).toBe(404);
  });

  it("viewer com filtros válidos → 200", async () => {
    autorizadoComo("viewer");
    const { client } = fakeSupabase({ data: [{ id: "a1", status: "agendado" }], error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/avaliacao/agendamentos?de=2026-01-01T00:00:00.000Z&ate=2026-01-07T23:59:59.999Z",
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: "a1", status: "agendado" }]);
  });

  it("sem role → 403", async () => {
    negado();
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/avaliacao/agendamentos?de=2026-01-01T00:00:00.000Z&ate=2026-01-07T23:59:59.999Z",
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/avaliacao/agendamentos", () => {
  const UNIT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/v1/avaliacao/agendamentos", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("corpo inválido → 422", async () => {
    autorizadoComo("agent");
    const { client } = fakeSupabase({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(postReq({ unit_id: UNIT }));
    expect(res.status).toBe(422);
  });
});
