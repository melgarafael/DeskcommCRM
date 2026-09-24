import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ATUAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANTIGA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

/** Admin stub: ponteiro aponta para ATUAL; versões listam ATUAL e ANTIGA. */
function adminStub() {
  return {
    from(table: string) {
      const b = {
        select() {
          return b;
        },
        eq() {
          return b;
        },
        order() {
          return Promise.resolve({
            data: [
              { id: ATUAL, created_at: "2026-09-19T10:00:00Z", forked_from_version_id: null },
              { id: ANTIGA, created_at: "2026-09-18T10:00:00Z", forked_from_version_id: null },
            ],
            error: null,
          });
        },
        async maybeSingle() {
          return { data: table === "skill_pointers" ? { version_id: ATUAL } : null, error: null };
        },
      };
      return b;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/ai/skills/[name]/versions", () => {
  it("sem auth → 401", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ name: "catalogo" }),
    });
    expect(res.status).toBe(401);
  });

  it("marca a versão em uso e lista o histórico", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ name: "catalogo" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { versions: Array<{ id: string; atual: boolean }> };
    };
    expect(body.data.versions).toHaveLength(2);
    expect(body.data.versions.find((v) => v.id === ATUAL)?.atual).toBe(true);
    expect(body.data.versions.find((v) => v.id === ANTIGA)?.atual).toBe(false);
  });
});
