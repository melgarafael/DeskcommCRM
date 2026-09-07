import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Épico Operação Visível (F1, review T4) — PATCH /api/v1/ai/memory/entries/[id]:
 *  - status:"archived" atualiza só status/updated_at (nunca source/proposal_id/
 *    created_by, mesmo se o body tentar mandar);
 *  - filtra por id E organization_id;
 *  - status fora do enum → 422 validation_failed.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "33333333-3333-4333-8333-333333333333";

interface UpdateState {
  payload: Record<string, unknown> | null;
  eqCalls: Array<[string, unknown]>;
}

function makeAdminStub(updateResult: { id: string; status: string } | null, state: UpdateState) {
  return {
    from(table: string) {
      if (table !== "org_memory_entries") throw new Error(`unexpected table ${table}`);
      const b = {
        update(payload: Record<string, unknown>) {
          state.payload = payload;
          return b;
        },
        eq(col: string, val: unknown) {
          state.eqCalls.push([col, val]);
          return b;
        },
        select() {
          return b;
        },
        single() {
          return Promise.resolve({ data: updateResult, error: updateResult ? null : new Error("boom") });
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
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

function patchReq(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/memory/entries/${ENTRY_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
function ctx() {
  return { params: Promise.resolve({ id: ENTRY_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/ai/memory/entries/[id]", () => {
  it("status:archived atualiza só status/updated_at e filtra por id + organization_id", async () => {
    mockAuthzOk();
    const state: UpdateState = { payload: null, eqCalls: [] };
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ id: ENTRY_ID, status: "archived" }, state) as never,
    );

    const { PATCH } = await import("./route");
    const res = await PATCH(
      patchReq({
        status: "archived",
        source: "flywheel",
        proposal_id: "should-not-pass",
        created_by: "should-not-pass",
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(state.payload).not.toBeNull();
    expect(state.payload).toMatchObject({ status: "archived" });
    expect(state.payload).toHaveProperty("updated_at");
    expect(Object.keys(state.payload as object).sort()).toEqual(["status", "updated_at"]);
    expect(state.payload).not.toHaveProperty("source");
    expect(state.payload).not.toHaveProperty("proposal_id");
    expect(state.payload).not.toHaveProperty("created_by");

    expect(state.eqCalls).toContainEqual(["id", ENTRY_ID]);
    expect(state.eqCalls).toContainEqual(["organization_id", ORG_ID]);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.org_memory_entry_updated", organizationId: ORG_ID }),
    );
  });

  it("status fora do enum → 422 validation_failed", async () => {
    mockAuthzOk();
    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ status: "proposed" }), ctx());
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
