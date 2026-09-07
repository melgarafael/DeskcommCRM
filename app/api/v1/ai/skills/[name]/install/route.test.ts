import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { installPlatformSkill } from "@/lib/ai/skills/install";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 5 — POST /api/v1/ai/skills/[name]/install: instala (fork) skill do
 * catálogo de plataforma pra org, org SEMPRE de requireRole; audit ai.skill_installed.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/skills/install", () => ({ installPlatformSkill: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function mockAuthzOk() {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

function makeAdminStub(found: boolean) {
  return {
    from() {
      const b = {
        select() {
          return b;
        },
        is() {
          return b;
        },
        eq() {
          return b;
        },
        maybeSingle() {
          return Promise.resolve({ data: found ? { name: "reativacao-d30" } : null, error: null });
        },
      };
      return b;
    },
  };
}

function req(name: string) {
  return new NextRequest(`http://localhost/api/v1/ai/skills/${name}/install`, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/skills/[name]/install", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { POST } = await import("./route");
    const res = await POST(req("reativacao-d30"), { params: Promise.resolve({ name: "reativacao-d30" }) });
    expect(res.status).toBe(401);
    expect(installPlatformSkill).not.toHaveBeenCalled();
  });

  it("skill no catálogo de plataforma → installPlatformSkill com org de requireRole, responde {version_id}, audita", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub(true) as never);
    vi.mocked(installPlatformSkill).mockResolvedValue({ versionId: "ver-fork-1" });

    const { POST } = await import("./route");
    const res = await POST(req("reativacao-d30"), { params: Promise.resolve({ name: "reativacao-d30" }) });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { version_id: string } };
    expect(body.data).toEqual({ version_id: "ver-fork-1" });

    const [, input] = vi.mocked(installPlatformSkill).mock.calls[0]!;
    expect(input.organizationId).toBe(ORG_ID);
    expect(input.name).toBe("reativacao-d30");

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.skill_installed", organizationId: ORG_ID, resourceId: "ver-fork-1" }),
    );
  });

  it("skill não existe no catálogo → 404, sem chamar installPlatformSkill", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub(false) as never);

    const { POST } = await import("./route");
    const res = await POST(req("inexistente"), { params: Promise.resolve({ name: "inexistente" }) });

    expect(res.status).toBe(404);
    expect(installPlatformSkill).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
