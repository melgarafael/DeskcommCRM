/**
 * G3-01 — claim/transfer/release com evento auditável (spec 13 §3.1, spec 04 §9).
 *
 * Prova, contra os Route Handlers REAIS (auth e Supabase mockados):
 *  - claim duplicado: rpc fn_conversation_assign devolve 0 rows → 409
 *    state_conflict e NENHUM audit de claim (o evento estruturado nem existe,
 *    porque a função só insere quando o UPDATE vence — mesma transação);
 *  - claim ok: rpc chamado com reason='claim' + optimistic lock ligado;
 *  - release: rpc com reason='release', expected = caller;
 *  - transfer: imediata (G1-06d — enforce_expected=false), Zod valida
 *    to_user_id, destino viewer/não-membro → 422, audita
 *    conversation.transferred com motivo em metadata.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface StubState {
  assignRows: Array<Record<string, unknown>>;
  rpcCalls: RpcCall[];
  targetMember: { role: string } | null;
}

const CONV_ROW = {
  id: CONV_ID,
  organization_id: ORG_ID,
  status: "claimed",
  assigned_to_user_id: AGENT_ID,
};

function makeSupabaseStub(state: StubState) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (fn === "fn_conversation_assign") return { data: state.assignRows, error: null };
      return { data: null, error: null };
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

function agentSession(state: StubState) {
  const user: AuthUser = {
    id: AGENT_ID,
    email: "agent@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(makeSupabaseStub(state) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub(state) as any);
}

function stubState(overrides: Partial<StubState> = {}): StubState {
  return {
    assignRows: [CONV_ROW],
    rpcCalls: [],
    targetMember: { role: "agent" },
    ...overrides,
  };
}

function postReq(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV_ID}/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: CONV_ID }) };

function assignCall(state: StubState): RpcCall | undefined {
  return state.rpcCalls.find((c) => c.fn === "fn_conversation_assign");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
});

describe("POST /claim — idempotência do claim atômico", () => {
  it("claim duplicado (0 rows do rpc) → 409 state_conflict, sem audit de claim", async () => {
    const state = stubState({ assignRows: [] });
    agentSession(state);
    const { POST } = await import("@/app/api/v1/conversations/[id]/claim/route");
    const res = await POST(postReq("claim", {}), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("state_conflict");
    expect(vi.mocked(audit).mock.calls.some(([e]) => e.action === "conversation.claimed")).toBe(
      false,
    );
  });

  it("claim livre → 200, rpc com reason='claim' e optimistic lock ligado", async () => {
    const state = stubState();
    agentSession(state);
    const { POST } = await import("@/app/api/v1/conversations/[id]/claim/route");
    const res = await POST(postReq("claim", { expected_assignee: null }), params);
    expect(res.status).toBe(200);
    expect(assignCall(state)?.args).toMatchObject({
      p_organization_id: ORG_ID,
      p_conversation_id: CONV_ID,
      p_to_user_id: AGENT_ID,
      p_reason: "claim",
      p_enforce_expected: true,
    });
  });
});

describe("POST /release — solta com evento na mesma transação", () => {
  it("release → rpc com reason='release' e expected = caller", async () => {
    const state = stubState({
      assignRows: [{ ...CONV_ROW, status: "open", assigned_to_user_id: null }],
    });
    agentSession(state);
    const { POST } = await import("@/app/api/v1/conversations/[id]/release/route");
    const res = await POST(postReq("release", {}), params);
    expect(res.status).toBe(200);
    expect(assignCall(state)?.args).toMatchObject({
      p_to_user_id: null,
      p_reason: "release",
      p_expected_assignee: AGENT_ID,
      p_enforce_expected: true,
    });
  });
});

describe("POST /transfer — reatribuição imediata (G1-06d)", () => {
  it("body sem to_user_id → 422, rpc não chamado", async () => {
    const state = stubState();
    agentSession(state);
    const { POST } = await import("@/app/api/v1/conversations/[id]/transfer/route");
    const res = await POST(postReq("transfer", {}), params);
    expect(res.status).toBe(422);
    expect(assignCall(state)).toBeUndefined();
  });

  it("transfer ok → 200, rpc reason='transfer' SEM optimistic lock, audit com motivo", async () => {
    const state = stubState({
      assignRows: [{ ...CONV_ROW, assigned_to_user_id: TARGET_ID }],
    });
    agentSession(state);
    const { POST } = await import("@/app/api/v1/conversations/[id]/transfer/route");
    const res = await POST(
      postReq("transfer", { to_user_id: TARGET_ID, reason: "cliente pediu o financeiro" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(assignCall(state)?.args).toMatchObject({
      p_organization_id: ORG_ID,
      p_to_user_id: TARGET_ID,
      p_reason: "transfer",
      p_enforce_expected: false,
    });
    const entry = vi
      .mocked(audit)
      .mock.calls.map(([e]) => e)
      .find((e) => e.action === "conversation.transferred");
    expect(entry).toMatchObject({
      actorUserId: AGENT_ID,
      organizationId: ORG_ID,
      resourceId: CONV_ID,
      metadata: { to_user_id: TARGET_ID, note: "cliente pediu o financeiro" },
    });
  });

  it("destino viewer → 422 unprocessable_entity, rpc não chamado", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
    const state = stubState({ targetMember: { role: "viewer" } });
    agentSession(state);
    const { POST } = await import("@/app/api/v1/conversations/[id]/transfer/route");
    const res = await POST(postReq("transfer", { to_user_id: TARGET_ID }), params);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unprocessable_entity");
    expect(assignCall(state)).toBeUndefined();
  });

  it("conversa inexistente (0 rows sem lock) → 404 not_found", async () => {
    const state = stubState({ assignRows: [] });
    agentSession(state);
    const { POST } = await import("@/app/api/v1/conversations/[id]/transfer/route");
    const res = await POST(postReq("transfer", { to_user_id: TARGET_ID }), params);
    expect(res.status).toBe(404);
  });
});
