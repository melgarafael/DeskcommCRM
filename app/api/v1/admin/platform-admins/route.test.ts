import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/admin/platform-admins — leitura da tabela que decide quem manda
 * na instalação inteira.
 *
 * A rota resolve e-mail pelo GoTrue. O SDK devolve AuthRetryableFetchError SEM
 * lançar em 504/500/socket fechado; tratar qualquer erro como "usuário não
 * existe" publicava uma lista de admins sem e-mail nenhum como se fosse o
 * estado real. Só 404/user_not_found é ausência de verdade (grant órfão).
 */

vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const GRANTER_ID = "33333333-3333-4333-8333-333333333333";

function paRow(userId: string, grantedBy: string | null) {
  return {
    user_id: userId,
    granted_by: grantedBy,
    granted_at: "2026-01-01T00:00:00Z",
    scope: "full",
    mfa_required: true,
    reason: "fundador",
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
  };
}

type AuthErrorStub = { message: string; status?: number; code?: string };

interface Cfg {
  rows?: unknown[];
  rowsError?: { message: string } | null;
  /** id → usuário do Auth, ou o erro que o GoTrue devolve para aquele id. */
  auth?: Record<string, { email: string } | { error: AuthErrorStub }>;
}

function makeAdminStub(cfg: Cfg) {
  const getUserById = vi.fn(async (uid: string) => {
    const entry = cfg.auth?.[uid];
    if (!entry) {
      return {
        data: { user: null },
        error: { message: "User not found", status: 404, code: "user_not_found" },
      };
    }
    if ("error" in entry) {
      return { data: { user: null }, error: entry.error };
    }
    return {
      data: { user: { id: uid, email: entry.email, user_metadata: { full_name: "Fulano" } } },
      error: null,
    };
  });

  const builder = {
    select: () => builder,
    order: () =>
      Promise.resolve({
        data: cfg.rowsError ? null : (cfg.rows ?? []),
        error: cfg.rowsError ?? null,
      }),
  };

  return {
    stub: {
      from: (table: string) => {
        if (table !== "platform_admins") throw new Error(`unexpected table ${table}`);
        return builder;
      },
      auth: { admin: { getUserById } },
    },
    getUserById,
  };
}

function req() {
  return new NextRequest("http://localhost/api/v1/admin/platform-admins");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
});

describe("GET /api/v1/admin/platform-admins", () => {
  it("devolve { data: [...] } sem aninhar o envelope dentro de si mesmo", async () => {
    const { stub } = makeAdminStub({
      rows: [paRow(ADMIN_ID, GRANTER_ID)],
      auth: {
        [ADMIN_ID]: { email: "admin@example.com" },
        [GRANTER_ID]: { email: "granter@example.com" },
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ id: string; user_email: string; granted_by_email: string }>;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).not.toHaveProperty("data");
    expect(body.data[0]).toMatchObject({
      id: ADMIN_ID,
      user_email: "admin@example.com",
      granted_by_email: "granter@example.com",
    });
  });

  it("GoTrue indisponível → 503, não uma lista de admins sem e-mail", async () => {
    const { stub } = makeAdminStub({
      rows: [paRow(ADMIN_ID, null)],
      auth: {
        // AuthRetryableFetchError: sem status 404 e sem code user_not_found.
        [ADMIN_ID]: { error: { message: "Failed to fetch", status: 504 } },
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_unavailable");
    expect(body).not.toHaveProperty("data");
  });

  it("grant órfão (404 user_not_found) mantém a linha com e-mail null", async () => {
    const { stub } = makeAdminStub({
      rows: [paRow(ADMIN_ID, GRANTER_ID)],
      // GRANTER_ID ausente do mapa → o dublê responde 404/user_not_found.
      auth: { [ADMIN_ID]: { email: "admin@example.com" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ user_email: string | null; granted_by_email: string | null }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.user_email).toBe("admin@example.com");
    expect(body.data[0]?.granted_by_email).toBeNull();
  });
});
