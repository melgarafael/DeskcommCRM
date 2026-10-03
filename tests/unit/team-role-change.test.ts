/**
 * G2-02 — PATCH /api/v1/team/[user_id] (role change).
 *
 * Prova, contra o Route Handler REAL (auth e Supabase mockados):
 *  - último admin da org não pode ser rebaixado (409 state_conflict, sem write);
 *  - com 2 admins ativos o rebaixamento passa (200) e audita
 *    action='team.role_changed' com actor e antes/depois;
 *  - role fora do enum → 422 validation_error (Zod);
 *  - o alias /role continua roteando pela mesma lógica.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, orgAtivaSemPortao, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
  // Sessão sem dívida de MFA: estes testes medem RBAC, não o gate de
  // segundo fator (que tem suíte própria em require-role-mfa.test.ts).
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

interface StubState {
  target: { id: string; user_id: string; role: string; revoked_at: string | null } | null;
  adminCount: number;
  updates: Array<Record<string, unknown>>;
}

/** Stub PostgREST cobrindo as 3 queries da rota (fetch, count de admins, update). */
function makeSupabaseStub(state: StubState) {
  return {
    from: (table: string) => {
      if (table !== "user_organizations") throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count) {
            const chain = {
              eq: () => chain,
              is: () => Promise.resolve({ count: state.adminCount, error: null }),
            };
            return chain;
          }
          const chain = {
            eq: () => chain,
            maybeSingle: () => Promise.resolve({ data: state.target, error: null }),
          };
          return chain;
        },
        update: (values: Record<string, unknown>) => ({
          eq: () => {
            state.updates.push(values);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org"
        ? { data: "admin", error: null }
        : { data: null, error: null },
  };
}

function adminSession(state: StubState) {
  const user: AuthUser = {
    id: ADMIN_ID,
    email: "admin@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin" });
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin", org_status: "active" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(makeSupabaseStub(state) as any);
}

function patchReq(role: string) {
  return new NextRequest(`http://localhost/api/v1/team/${TARGET_ID}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}
const params = { params: Promise.resolve({ user_id: TARGET_ID }) };

function stubState(overrides: Partial<StubState> = {}): StubState {
  return {
    target: { id: MEMBERSHIP_ID, user_id: TARGET_ID, role: "admin", revoked_at: null },
    adminCount: 2,
    updates: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/team/[user_id] — guard de último admin", () => {
  it("rebaixar o último admin → 409 state_conflict, sem write e sem audit de mudança", async () => {
    const state = stubState({ adminCount: 1 });
    adminSession(state);
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/route");
    const res = await PATCH(patchReq("agent"), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("state_conflict");
    expect(state.updates).toHaveLength(0);
    expect(
      vi.mocked(audit).mock.calls.some(([e]) => e.action === "team.role_changed"),
    ).toBe(false);
  });

  it("rebaixar admin com 2 admins ativos → 200 e write efetuado", async () => {
    const state = stubState({ adminCount: 2 });
    adminSession(state);
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/route");
    const res = await PATCH(patchReq("manager"), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { user_id: string; role: string } };
    expect(body.data).toMatchObject({ user_id: TARGET_ID, role: "manager" });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ role: "manager" });
  });
});

describe("PATCH /api/v1/team/[user_id] — audit team.role_changed", () => {
  it("mudança audita action='team.role_changed' com actor e antes/depois", async () => {
    const state = stubState({
      target: { id: MEMBERSHIP_ID, user_id: TARGET_ID, role: "agent", revoked_at: null },
    });
    adminSession(state);
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/route");
    const res = await PATCH(patchReq("manager"), params);
    expect(res.status).toBe(200);
    const entry = vi
      .mocked(audit)
      .mock.calls.map(([e]) => e)
      .find((e) => e.action === "team.role_changed");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      action: "team.role_changed",
      actorUserId: ADMIN_ID,
      organizationId: ORG_ID,
      resourceType: "membership",
      resourceId: MEMBERSHIP_ID,
      metadata: {
        target_user_id: TARGET_ID,
        old_role: "agent",
        new_role: "manager",
      },
    });
  });
});

describe("PATCH /api/v1/team/[user_id] — validação Zod", () => {
  it("role fora do enum → 422 validation_error, sem write", async () => {
    const state = stubState();
    adminSession(state);
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/route");
    const res = await PATCH(patchReq("superuser"), params);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
    expect(state.updates).toHaveLength(0);
  });
});

describe("PATCH /api/v1/team/[user_id]/role — alias compartilha a mesma lógica", () => {
  it("último admin também é protegido via alias /role", async () => {
    const state = stubState({ adminCount: 1 });
    adminSession(state);
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/role/route");
    const res = await PATCH(patchReq("viewer"), params);
    expect(res.status).toBe(409);
    expect(state.updates).toHaveLength(0);
  });
});
