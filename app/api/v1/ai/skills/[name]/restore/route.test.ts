import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/skills", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent-engine/agent/skills")>();
  return { ...real, setSkillPointer: vi.fn() };
});

import { setSkillPointer } from "@/lib/agent-engine/agent/skills";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

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

function adminStub(versao: { id: string } | null) {
  return {
    from() {
      const b = {
        select() {
          return b;
        },
        eq() {
          return b;
        },
        async maybeSingle() {
          return { data: versao, error: null };
        },
      };
      return b;
    },
  };
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/skills/catalogo/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/ai/skills/[name]/restore", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { POST } = await import("./route");
    const res = await POST(req({ version_id: VERSION_ID }), {
      params: Promise.resolve({ name: "catalogo" }),
    });
    expect(res.status).toBe(401);
  });

  it("versão não pertence à org/nome → 404, sem mover ponteiro", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(adminStub(null) as never);
    const { POST } = await import("./route");
    const res = await POST(req({ version_id: VERSION_ID }), {
      params: Promise.resolve({ name: "catalogo" }),
    });
    expect(res.status).toBe(404);
    expect(setSkillPointer).not.toHaveBeenCalled();
  });

  it("sucesso → move o ponteiro e audita ai.skill_restored", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(adminStub({ id: VERSION_ID }) as never);
    vi.mocked(setSkillPointer).mockResolvedValue(undefined as never);
    const { POST } = await import("./route");
    const res = await POST(req({ version_id: VERSION_ID }), {
      params: Promise.resolve({ name: "catalogo" }),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(setSkillPointer)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: ORG_ID, name: "catalogo", versionId: VERSION_ID }),
    );
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.skill_restored", organizationId: ORG_ID }),
    );
  });

  it("body inválido → 422", async () => {
    mockAuthzOk();
    const { POST } = await import("./route");
    const res = await POST(req({ version_id: "não-uuid" }), {
      params: Promise.resolve({ name: "catalogo" }),
    });
    expect(res.status).toBe(422);
    expect(setSkillPointer).not.toHaveBeenCalled();
  });
});
