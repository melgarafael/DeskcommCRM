import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 5 (Fase 2 skills instaláveis) — GET /api/v1/ai/skills:
 *  - sem auth → repassa authz.response;
 *  - installed = pointers da org (join descrição + source manual/catalog pelo
 *    forked_from_version_id); catalog = pointers de plataforma cujo name NÃO
 *    está em installed.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

interface Stubs {
  orgPointers?: Array<{ name: string; version_id: string | null; updated_at: string }>;
  orgPointersError?: unknown;
  platformPointers?: Array<{ name: string; version_id: string | null }>;
  platformPointersError?: unknown;
  versions?: Array<{ id: string; description: string; forked_from_version_id: string | null }>;
  versionsError?: unknown;
  rejectNullVersionIds?: boolean;
}

function makeAdminStub(cfg: Stubs) {
  return {
    from(table: string) {
      if (table !== "skill_pointers" && table !== "skill_versions") {
        throw new Error(`unexpected table ${table}`);
      }
      let isNullOrg = false;
      const b = {
        select() {
          return b;
        },
        eq(col: string) {
          if (col === "organization_id") isNullOrg = false;
          return b;
        },
        is(col: string) {
          if (col === "organization_id") isNullOrg = true;
          return b;
        },
        in(_column: string, values: unknown[]) {
          if (cfg.rejectNullVersionIds && values.some((value) => value === null)) {
            return Promise.resolve({
              data: null,
              error: { message: "invalid input syntax for type uuid" },
            });
          }
          return Promise.resolve({ data: cfg.versions ?? [], error: cfg.versionsError ?? null });
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          if (table === "skill_pointers" && !isNullOrg) {
            return Promise.resolve({
              data: cfg.orgPointers ?? [],
              error: cfg.orgPointersError ?? null,
            }).then(onF, onR);
          }
          return Promise.resolve({
            data: cfg.platformPointers ?? [],
            error: cfg.platformPointersError ?? null,
          }).then(onF, onR);
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
}

function getReq() {
  return new NextRequest("http://localhost/api/v1/ai/skills");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/ai/skills", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it("separa installed (org) de catalog (plataforma não instalada) e resolve source", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        orgPointers: [
          { name: "frete-gratis", version_id: "ver-org-1", updated_at: "2026-07-20T00:00:00Z" },
        ],
        platformPointers: [
          { name: "frete-gratis", version_id: "ver-plat-1" },
          { name: "reativacao-d30", version_id: "ver-plat-2" },
        ],
        versions: [
          {
            id: "ver-org-1",
            description: "Explica frete (fork).",
            forked_from_version_id: "ver-plat-1",
          },
          {
            id: "ver-plat-1",
            description: "Explica frete (plataforma).",
            forked_from_version_id: null,
          },
          { id: "ver-plat-2", description: "Reativação D+30.", forked_from_version_id: null },
        ],
      }) as never,
    );
    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        installed: Array<{
          name: string;
          description: string;
          version_id: string;
          source: string;
          updated_at: string;
        }>;
        catalog: Array<{ name: string; description: string }>;
      };
    };
    expect(body.data.installed).toEqual([
      {
        name: "frete-gratis",
        description: "Explica frete (fork).",
        version_id: "ver-org-1",
        source: "catalog",
        updated_at: "2026-07-20T00:00:00Z",
      },
    ]);
    // frete-gratis já instalada pela org → sai do catálogo; só reativacao-d30 sobra.
    expect(body.data.catalog).toEqual([
      { name: "reativacao-d30", description: "Reativação D+30." },
    ]);
  });

  it("erro ao ler pointers da org → 500 internal_error", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ orgPointersError: { message: "boom" } }) as never,
    );
    const { GET } = await import("./route");
    const res = await GET(getReq());
    expect(res.status).toBe(500);
  });

  it("ponteiro legado sem version_id não derruba a listagem inteira", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        platformPointers: [{ name: "agendamento", version_id: null }],
        rejectNullVersionIds: true,
      }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(getReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { installed: [], catalog: [] } });
  });
});
