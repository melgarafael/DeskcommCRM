import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";
import { validateBearerToken } from "@/lib/mcp/auth";

/**
 * Épico Operação Visível (F1, review T4) — GET /api/v1/ai/memory/versions/[id]:
 *  - filtra por organization_id (não só id — service role bypassa RLS);
 *  - versão não encontrada nesta org → 404 not_found.
 *
 * O handler agora resolve auth por `resolveAuthDual` (sessão OU token).
 * Na sessão, `createClient()` é usado; no token, `createAdminClient()` e
 * `validateBearerToken()`. Os testes de sessão mantêm `requireRole` e ganham
 * `createClient` mockado com o mesmo dublê que `createAdminClient`.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

interface QueryState {
  eqCalls: Array<[string, unknown]>;
}

function makeAdminStub(
  result: { id: string; version_number: number; content: string; created_at: string } | null,
  state: QueryState,
) {
  return {
    from(table: string) {
      if (table !== "org_memory_versions") throw new Error(`unexpected table ${table}`);
      const b = {
        select() {
          return b;
        },
        eq(col: string, val: unknown) {
          state.eqCalls.push([col, val]);
          return b;
        },
        maybeSingle() {
          return Promise.resolve({ data: result, error: null });
        },
      };
      return b;
    },
  };
}

function mockAuthzOk() {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
  vi.mocked(createClient).mockResolvedValue(
    makeAdminStub(
      { id: VERSION_ID, version_number: 2, content: "texto", created_at: "2026-01-01T00:00:00Z" },
      { eqCalls: [] },
    ) as never,
  );
  vi.mocked(validateBearerToken).mockResolvedValue(null as never);
}

function getReq() {
  return new NextRequest(`http://localhost/api/v1/ai/memory/versions/${VERSION_ID}`);
}
function ctx() {
  return { params: Promise.resolve({ id: VERSION_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/ai/memory/versions/[id]", () => {
  it("filtra por id e organization_id", async () => {
    mockAuthzOk();
    const state: QueryState = { eqCalls: [] };
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub(
        { id: VERSION_ID, version_number: 2, content: "texto", created_at: "2026-01-01T00:00:00Z" },
        state,
      ) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(getReq(), ctx());

    expect(res.status).toBe(200);
    expect(state.eqCalls).toContainEqual(["id", VERSION_ID]);
    expect(state.eqCalls).toContainEqual(["organization_id", ORG_ID]);
  });

  it("versão não encontrada nesta org → 404 not_found", async () => {
    mockAuthzOk();
    const state: QueryState = { eqCalls: [] };
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub(null, state) as never);

    const { GET } = await import("./route");
    const res = await GET(getReq(), ctx());

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
