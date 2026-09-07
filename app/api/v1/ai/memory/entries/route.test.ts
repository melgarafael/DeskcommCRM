import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Épico Operação Visível (F1, review T4) — POST /api/v1/ai/memory/entries:
 *  - cria entrada com organization_id do requireRole (nunca do body, mesmo se
 *    o body tentar mandar outro organization_id);
 *  - body inválido → 422 validation_failed.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "99999999-9999-4999-8999-999999999999";
const USER_ID = "11111111-1111-4111-8111-111111111111";

interface InsertState {
  payload: Record<string, unknown> | null;
}

function makeAdminStub(insertResult: { id: string } | null, state: InsertState) {
  return {
    from(table: string) {
      if (table !== "org_memory_entries") throw new Error(`unexpected table ${table}`);
      return {
        insert(payload: Record<string, unknown>) {
          state.payload = payload;
          return this;
        },
        select() {
          return this;
        },
        single() {
          return Promise.resolve({ data: insertResult, error: insertResult ? null : new Error("boom") });
        },
      };
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
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/memory/entries", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/memory/entries", () => {
  it("cria entrada com organization_id do requireRole, ignorando organization_id do body", async () => {
    mockAuthzOk();
    const state: InsertState = { payload: null };
    vi.mocked(createAdminClient).mockReturnValue(makeAdminStub({ id: "entry-1" }, state) as never);

    const { POST } = await import("./route");
    const res = await POST(
      postReq({ title: "Lição", body: "Conteúdo", organization_id: OTHER_ORG_ID }),
    );

    expect(res.status).toBe(200);
    expect(state.payload).not.toBeNull();
    expect(state.payload?.organization_id).toBe(ORG_ID);
    expect(state.payload?.organization_id).not.toBe(OTHER_ORG_ID);
    expect(state.payload).toMatchObject({
      title: "Lição",
      body: "Conteúdo",
      source: "manual",
      status: "active",
      created_by: USER_ID,
    });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.org_memory_entry_created", organizationId: ORG_ID }),
    );
  });

  it("body inválido (title vazio) → 422 validation_failed", async () => {
    mockAuthzOk();
    const { POST } = await import("./route");
    const res = await POST(postReq({ title: "", body: "Conteúdo" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
