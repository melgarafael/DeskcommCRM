import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 5 — DELETE /api/v1/ai/skills/[name]: remove SÓ o skill_pointers da org
 * (não apaga skill_versions — histórico imutável); audit ai.skill_uninstalled.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/skills", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent-engine/agent/skills")>();
  return { ...real, insertSkillVersion: vi.fn(), setSkillPointer: vi.fn() };
});

import { insertSkillVersion, setSkillPointer } from "@/lib/agent-engine/agent/skills";

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

function makeAdminStub(deletedRows: Array<{ name: string }> | null, error: unknown = null) {
  const eqCalls: Array<[string, unknown]> = [];
  return {
    from() {
      const b = {
        delete() {
          return b;
        },
        eq(col: string, val: unknown) {
          eqCalls.push([col, val]);
          return b;
        },
        select() {
          return Promise.resolve({ data: deletedRows, error });
        },
      };
      return b;
    },
    __eqCalls: eqCalls,
  };
}

function req(name: string) {
  return new NextRequest(`http://localhost/api/v1/ai/skills/${name}`, { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/v1/ai/skills/[name]", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(req("frete-gratis"), { params: Promise.resolve({ name: "frete-gratis" }) });
    expect(res.status).toBe(401);
  });

  it("pointer existe na org → remove, responde {name}, audita", async () => {
    mockAuthzOk();
    const stub = makeAdminStub([{ name: "frete-gratis" }]);
    vi.mocked(createAdminClient).mockReturnValue(stub as never);

    const { DELETE } = await import("./route");
    const res = await DELETE(req("frete-gratis"), { params: Promise.resolve({ name: "frete-gratis" }) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data).toEqual({ name: "frete-gratis" });
    expect(stub.__eqCalls).toContainEqual(["organization_id", ORG_ID]);
    expect(stub.__eqCalls).toContainEqual(["name", "frete-gratis"]);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.skill_uninstalled", organizationId: ORG_ID }),
    );
  });

  it("pointer não existe na org → 404, sem audit", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub([]) as never);

    const { DELETE } = await import("./route");
    const res = await DELETE(req("nao-instalada"), { params: Promise.resolve({ name: "nao-instalada" }) });

    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });
});

function makeAdminGetStub(input: {
  pointer: { version_id: string; updated_at: string } | null;
  version?: { id: string; name: string; description: string; body: string; matcher: unknown } | null;
}) {
  return {
    from(table: string) {
      const b = {
        select() {
          return b;
        },
        eq() {
          return b;
        },
        async maybeSingle() {
          if (table === "skill_pointers") return { data: input.pointer, error: null };
          return { data: input.version ?? null, error: null };
        },
      };
      return b;
    },
  };
}

function reqGet(name: string) {
  return new NextRequest(`http://localhost/api/v1/ai/skills/${name}`, { method: "GET" });
}

function reqPut(name: string, body: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/skills/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY_VALIDO = {
  description: "Como apresentar o catálogo.",
  body: "# Catálogo\n- mostre as motos",
  matcher: { any_keywords: ["moto", "cb"] },
};

describe("GET /api/v1/ai/skills/[name]", () => {
  it("skill instalada → devolve corpo e matcher", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminGetStub({
        pointer: { version_id: "v1", updated_at: "2026-09-19T00:00:00Z" },
        version: { id: "v1", name: "catalogo", description: "d", body: "b", matcher: { any_keywords: ["moto"] } },
      }) as never,
    );
    const { GET } = await import("./route");
    const res = await GET(reqGet("catalogo"), { params: Promise.resolve({ name: "catalogo" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { body: string; matcher: { any_keywords: string[] } } };
    expect(body.data.body).toBe("b");
    expect(body.data.matcher.any_keywords).toEqual(["moto"]);
  });

  it("skill não instalada → 404", async () => {
    mockAuthzOk();
    vi.mocked(createAdminClient).mockReturnValue(makeAdminGetStub({ pointer: null }) as never);
    const { GET } = await import("./route");
    const res = await GET(reqGet("nao-instalada"), { params: Promise.resolve({ name: "nao-instalada" }) });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/v1/ai/skills/[name]", () => {
  it("salva nova versão e move o ponteiro; audita ai.skill_saved", async () => {
    mockAuthzOk();
    vi.mocked(insertSkillVersion).mockResolvedValue({ id: "v2" } as never);
    vi.mocked(setSkillPointer).mockResolvedValue(undefined as never);

    const { PUT } = await import("./route");
    const res = await PUT(reqPut("catalogo", BODY_VALIDO), { params: Promise.resolve({ name: "catalogo" }) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; version_id: string } };
    expect(body.data).toEqual({ name: "catalogo", version_id: "v2" });
    expect(vi.mocked(insertSkillVersion)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: ORG_ID, name: "catalogo", body: BODY_VALIDO.body }),
    );
    expect(vi.mocked(setSkillPointer)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: ORG_ID, name: "catalogo", versionId: "v2" }),
    );
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.skill_saved", organizationId: ORG_ID }),
    );
  });

  it("matcher sem palavras-chave → 422, sem tocar o banco", async () => {
    mockAuthzOk();
    const { PUT } = await import("./route");
    const res = await PUT(
      reqPut("catalogo", { ...BODY_VALIDO, matcher: { any_keywords: [] } }),
      { params: Promise.resolve({ name: "catalogo" }) },
    );
    expect(res.status).toBe(422);
    expect(insertSkillVersion).not.toHaveBeenCalled();
  });

  it("teto de linhas estourado (insert lança) → 422 com a mensagem", async () => {
    mockAuthzOk();
    vi.mocked(insertSkillVersion).mockRejectedValue(new Error("corpo de skill com 999 linhas excede o teto de 200"));
    const { PUT } = await import("./route");
    const res = await PUT(reqPut("catalogo", BODY_VALIDO), { params: Promise.resolve({ name: "catalogo" }) });
    expect(res.status).toBe(422);
    expect(setSkillPointer).not.toHaveBeenCalled();
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
