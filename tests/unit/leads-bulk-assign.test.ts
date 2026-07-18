/**
 * G3-04 — atribuição em massa de leads (spec 04 §6.5).
 *
 * Prova, contra o Route Handler REAL (auth e Supabase mockados):
 *  - gate ≥manager por-action: agent tentando `assign` → 403 forbidden_role,
 *    sem UPDATE nem audit agregado (move/tag/delete continuam agent+, fora daqui);
 *  - sucesso (manager): UPDATE único de owner_user_id, retorna updated_count e
 *    audita UMA entrada agregada `leads.bulk_assigned` com count + owner_user_id;
 *  - owner fora da org / não-membro / viewer → 422 invalid_owner (código estável),
 *    sem UPDATE;
 *  - desatribuir (owner_user_id null) é válido e pula a validação de membership;
 *  - limite: acima do teto (MAX_BULK=50) → 422, sem UPDATE.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));

const MANAGER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const LEAD_A = "44444444-4444-4444-8444-444444444444";
const LEAD_B = "55555555-5555-4555-8555-555555555555";

interface StubState {
  scopedRows: Array<Record<string, unknown>>;
  affectedRows: Array<{ id: string }>;
  targetMember: { role: string } | null;
  updateCalled: boolean;
}

function stubState(overrides: Partial<StubState> = {}): StubState {
  return {
    scopedRows: [
      { id: LEAD_A, organization_id: ORG_ID, tags: [] },
      { id: LEAD_B, organization_id: ORG_ID, tags: [] },
    ],
    affectedRows: [{ id: LEAD_A }, { id: LEAD_B }],
    targetMember: { role: "agent" },
    updateCalled: false,
    ...overrides,
  };
}

function makeSupabaseStub(state: StubState) {
  return {
    from: () => {
      const b = {
        _op: "select" as "select" | "update" | "delete",
        select() {
          return b;
        },
        update() {
          b._op = "update";
          state.updateCalled = true;
          return b;
        },
        delete() {
          b._op = "delete";
          return b;
        },
        in() {
          return b;
        },
        eq() {
          return b;
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const result =
            b._op === "select"
              ? { data: state.scopedRows, error: null }
              : { data: state.affectedRows, error: null };
          return Promise.resolve(result).then(onF, onR);
        },
      };
      return b;
    },
    rpc() {
      return { then: (onF: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(onF) };
    },
  };
}

function makeAdminStub(state: StubState) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve({ data: state.targetMember, error: null }),
  };
  return { from: () => chain };
}

function session(effectiveRole: Role, state: StubState) {
  const user: AuthUser = {
    id: MANAGER_ID,
    email: "m@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: effectiveRole }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[effectiveRole] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG_ID, name: "Org", role: effectiveRole } };
    }
    return {
      ok: false,
      response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}),
    };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(makeSupabaseStub(state) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub(state) as any);
}

function postReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/leads/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function assignBody(owner: string | null, leadIds: string[] = [LEAD_A, LEAD_B]) {
  return { action: "assign", lead_ids: leadIds, params: { owner_user_id: owner } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
});

describe("POST /api/v1/leads/bulk — assign gate ≥manager", () => {
  it("agent tentando assign → 403 forbidden_role, sem UPDATE", async () => {
    const state = stubState();
    session("agent", state);
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(postReq(assignBody(OWNER_ID)));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden_role");
    expect(state.updateCalled).toBe(false);
    expect(vi.mocked(audit).mock.calls.some(([e]) => e.action === "leads.bulk_assigned")).toBe(
      false,
    );
    // A negação passa pelo requireRole("manager") da G2-01 (que emite o
    // authz.denied internamente) — não por um fail(403) na mão.
    expect(vi.mocked(requireRole)).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "crm_leads" }),
    );
  });

  it("manager → 200, UPDATE único, audit agregado leads.bulk_assigned com count", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
    const state = stubState({ targetMember: { role: "agent" } });
    session("manager", state);
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(postReq(assignBody(OWNER_ID)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { updated_count: number } };
    expect(body.data.updated_count).toBe(2);
    expect(state.updateCalled).toBe(true);
    const entry = vi
      .mocked(audit)
      .mock.calls.map(([e]) => e)
      .find((e) => e.action === "leads.bulk_assigned");
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({ count: 2, owner_user_id: OWNER_ID });
  });
});

describe("POST /api/v1/leads/bulk — validação de owner", () => {
  it("owner não-membro da org → 422 invalid_owner, sem UPDATE", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
    const state = stubState({ targetMember: null });
    session("manager", state);
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(postReq(assignBody(OWNER_ID)));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_owner");
    expect(state.updateCalled).toBe(false);
  });

  it("owner viewer da org → 422 invalid_owner", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
    const state = stubState({ targetMember: { role: "viewer" } });
    session("manager", state);
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(postReq(assignBody(OWNER_ID)));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_owner");
  });

  it("INB-09 nota 1: sem service role + owner não-null → 422 owner_validation_unavailable, sem UPDATE (fail-closed)", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
    const state = stubState();
    session("manager", state);
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(postReq(assignBody(OWNER_ID)));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("owner_validation_unavailable");
    expect(state.updateCalled).toBe(false);
  });

  it("desatribuir (owner_user_id null) → 200, pula validação de membership", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
    const state = stubState({ targetMember: null });
    session("manager", state);
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(postReq(assignBody(null)));
    expect(res.status).toBe(200);
    expect(state.updateCalled).toBe(true);
  });
});

describe("POST /api/v1/leads/bulk — limite (MAX_BULK=50)", () => {
  it("acima do teto → 422, sem UPDATE", async () => {
    const state = stubState();
    session("manager", state);
    const tooMany = Array.from(
      { length: 51 },
      (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`,
    );
    const { POST } = await import("@/app/api/v1/leads/bulk/route");
    const res = await POST(postReq(assignBody(OWNER_ID, tooMany)));
    expect(res.status).toBe(422);
    expect(state.updateCalled).toBe(false);
  });
});
