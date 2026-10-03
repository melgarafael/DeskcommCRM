import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

/**
 * GET /api/v1/ai/knowledge/sources — lista de fontes de RAG (tela de cliente).
 *
 * `ok()` já embrulha em `{ data }`. A rota passava `{ data: rows }`, o corpo
 * saía `{ data: { data: [...] } }`, e o hook fazia `(res.data ?? []).filter(...)`
 * sobre o envelope — TypeError. A lista só aparecia pelo SSR e nunca atualizava
 * depois de criar ou reindexar uma fonte.
 */

vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// `orgAtivaDaApi` REAL (sobre o `orgAtivaSemPortao` mockado): é ela que decide o 403 da org suspensa.
vi.mock("@/lib/auth/require-role", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireRole: vi.fn(),
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";

const SOURCE = {
  id: "66666666-6666-4666-8666-666666666666",
  agent_id: AGENT_ID,
  organization_id: ORG_ID,
  source_type: "faq",
  name: "FAQ da loja",
  status: "ready",
  last_index_status: null,
  last_index_error: null,
  last_indexed_at: null,
  chunks_count: 3,
  is_active: true,
  source_metadata: {},
  ingested_at: null,
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
};

function makeSupabaseStub(rows: unknown[]) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: async () => ({ data: rows, error: null }),
  };
  return { from: () => builder };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [
      { organization_id: ORG_ID, organization_name: "Org", role: "manager" },
    ],
  } as AuthUser);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({
    orgId: ORG_ID,
    name: "Org",
    role: "manager",
    org_status: "active",
  } as never);
});

describe("GET /api/v1/ai/knowledge/sources", () => {
  it("body.data é a lista, não um envelope com outra lista dentro", async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabaseStub([SOURCE]) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/v1/ai/knowledge/sources"),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Array<{ agent_id: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).not.toHaveProperty("data");
    // É exatamente o que o hook faz com a resposta: se o corpo vier aninhado,
    // isto estoura com "filter is not a function".
    expect(() => body.data.filter((s) => s.agent_id === AGENT_ID)).not.toThrow();
    expect(body.data.filter((s) => s.agent_id === AGENT_ID)).toHaveLength(1);
  });
});
