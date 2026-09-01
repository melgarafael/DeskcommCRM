import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";
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
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

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
  vi.mocked(resolveActiveOrg).mockResolvedValue({
    orgId: ORG_ID,
    name: "Org",
    role: "manager",
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

describe("POST /api/v1/ai/knowledge/sources (catalog via CSV)", () => {
  beforeEach(() => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "11111111-1111-4111-8111-111111111111" } as AuthUser,
      org: { orgId: ORG_ID, name: "Org", role: "manager" },
    } as never);

    // Lookup do agent (via createClient, user-scoped) — sempre encontra.
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: AGENT_ID }, error: null }),
            }),
          }),
        }),
      }),
    } as never);
  });

  function makeAdminStub() {
    const faqRowsInserted: unknown[] = [];
    return {
      stub: {
        from(table: string) {
          if (table === "ai_knowledge_sources") {
            return {
              insert: () => ({
                select: () => ({
                  single: async () => ({ data: { id: SOURCE.id }, error: null }),
                }),
              }),
            };
          }
          if (table === "ai_faq_items") {
            return {
              insert: async (rows: unknown[]) => {
                faqRowsInserted.push(...rows);
                return { error: null };
              },
            };
          }
          throw new Error(`unexpected table ${table}`);
        },
        rpc: async () => ({ error: null }),
      },
      faqRowsInserted,
    };
  }

  it("cria a fonte com as linhas válidas e devolve row_errors das inválidas", async () => {
    const { stub, faqRowsInserted } = makeAdminStub();
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { POST } = await import("./route");
    const csv = ["nome,preco", "Produto A,100", "Produto B,não é número"].join("\n");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/ai/knowledge/sources", {
        method: "POST",
        body: JSON.stringify({
          agent_id: AGENT_ID,
          source_type: "catalog",
          name: "Catálogo da loja",
          csv_blob: csv,
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { items_count: number; row_errors?: Array<{ row: number; reason: string }> };
    };
    expect(body.data.items_count).toBe(1);
    expect(body.data.row_errors).toEqual([
      { row: 3, reason: 'Preço "não é número" não é um valor válido.' },
    ]);
    expect(faqRowsInserted).toHaveLength(1);
  });

  it("recusa quando NENHUMA linha da planilha é válida", async () => {
    const { stub } = makeAdminStub();
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { POST } = await import("./route");
    const csv = ["nome,preco", ",100"].join("\n");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/ai/knowledge/sources", {
        method: "POST",
        body: JSON.stringify({
          agent_id: AGENT_ID,
          source_type: "catalog",
          name: "Catálogo da loja",
          csv_blob: csv,
        }),
      }),
    );

    expect(res.status).toBe(400);
  });
});
