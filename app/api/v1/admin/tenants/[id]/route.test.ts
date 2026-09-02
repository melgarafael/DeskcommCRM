import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/admin/tenants/[id] — cabeçalho do tenant no painel de plataforma.
 *
 * O contador de LGPD filtrava `status = 'pending'`, valor que não existe em
 * `lgpd_requests_status_check` (received/processing/completed/failed/expired):
 * era sempre 0, e a tela jurava que o tenant não devia nada à LGPD.
 *
 * O dublê abaixo aplica o filtro sobre linhas com status do vocabulário REAL —
 * é isso que faz o teste reprovar um predicado que compara com valor imaginado.
 */

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const ORG = {
  id: ORG_ID,
  slug: "org",
  display_name: "Org",
  legal_name: null,
  nuit: null,
  status: "active",
  onboarded_at: "2026-01-01T00:00:00Z",
  suspended_at: null,
  created_at: "2026-01-01T00:00:00Z",
  settings: {},
};

/** Linhas de lgpd_requests com status do vocabulário real do CHECK. */
const LGPD_ROWS = [
  { status: "received" },
  { status: "processing" },
  { status: "completed" },
  { status: "failed" },
];

type Filtro =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "not_in"; col: string; vals: string[] };

function lgpdBuilder() {
  const filtros: Filtro[] = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filtros.push({ kind: "eq", col, val });
      return builder;
    },
    not: (col: string, op: string, list: string) => {
      if (op !== "in") throw new Error(`operador não simulado: ${op}`);
      filtros.push({
        kind: "not_in",
        col,
        vals: list.replace(/^\(|\)$/g, "").split(","),
      });
      return builder;
    },
    then(resolve: (v: { count: number; error: null }) => unknown) {
      const count = LGPD_ROWS.filter((row) =>
        filtros.every((f) => {
          if (f.col === "organization_id") return true;
          if (f.kind === "eq") return row.status === f.val;
          return !f.vals.includes(row.status);
        }),
      ).length;
      return Promise.resolve({ count, error: null }).then(resolve);
    },
  };
  return builder;
}

function contadorVazio() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "is", "not", "limit", "order"]) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ count: 0, data: [], error: null }).then(resolve);
  builder.single = async () => ({ data: ORG, error: null });
  return builder;
}

function makeAdminStub() {
  return {
    from: (table: string) =>
      table === "lgpd_requests" ? lgpdBuilder() : contadorVazio(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub() as never);
});

describe("GET /api/v1/admin/tenants/[id]", () => {
  it("conta como pendente o que o banco realmente grava (received/processing)", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { counts: { lgpd_requests_pending: number } };
    };
    expect(body.data.counts.lgpd_requests_pending).toBe(2);
  });
});
