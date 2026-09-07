/**
 * G3-02 + G6-01 (INB-12) — crm_request_human_handoff v2.
 *
 * Prova, contra a tool REAL (ctx.supabase mockado, triggerHandoff mockado):
 *  - a escolha do destino usa o roteamento G5 (loadEligibleAttendants +
 *    selectRoundRobin) — DETERMINÍSTICO sobre elegíveis, NÃO o antigo
 *    pickRoundRobinAssignee random sobre user_organizations;
 *  - com elegível: rpc fn_channel_routing_claim p_reason='handoff' + retorno
 *    estruturado { assigned_to };
 *  - target_user_id elegível: atribui ao alvo;
 *  - sem elegível: fila — assignee_kind limpo + evento reason='handoff' from/to
 *    null + retorno { queued:true, position }.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { crmRequestHumanHandoff } from "@/lib/mcp/tools/handoff";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "33333333-3333-4333-8333-333333333333";

interface Query {
  table: string;
  select: string | null;
  count: boolean;
  terminal: "maybeSingle" | "then";
}

interface StubState {
  /** atendentes em attendant_availability (is_available=true). */
  attendants: Array<{ user_id: string; capacity: number; schedule: unknown }>;
  queuePositionCount: number;
  allowed?: string[];
  claimResult?: string;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeSupabaseStub(state: StubState) {
  const from = (table: string) => {
    const q: Query = { table, select: null, count: false, terminal: "then" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols: string, opts?: { head?: boolean }) => {
        q.select = cols;
        q.count = Boolean(opts?.head);
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      lte: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (values: Record<string, unknown>) => {
        state.updates.push({ table, values });
        return chain;
      },
      insert: (values: Record<string, unknown>) => {
        state.inserts.push({ table, values });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle: () => {
        if (table === "conversations") {
          return Promise.resolve({
            data: {
              id: CONV_ID,
              organization_id: ORG_ID,
              contact_id: null, channel_session_id: CONV_ID, assigned_to_user_id: null,
              last_inbound_at: null,
            },
            error: null,
          });
        }
        if (table === "channel_sessions") return Promise.resolve({ data: { id: CONV_ID }, error: null });
        if (table === "channel_routing_policies") return Promise.resolve({ data: state.allowed ? { id: "policy" } : null, error: null });
        return Promise.resolve({ data: null, error: null }); // crm_leads lookup
      },
      then: (resolve: (v: unknown) => unknown) => {
        let result: { data?: unknown; count?: number; error: null } = { data: [], error: null };
        if (table === "user_organizations") result = { data: state.attendants.map(a => ({ user_id: a.user_id })), error: null };
        else if (table === "channel_routing_responsibles") result = { data: (state.allowed ?? []).map(user_id => ({ user_id })), error: null };
        else if (table === "conversations" && state.updates.length) result = { data: [{ id: CONV_ID }], error: null };
        if (table === "attendant_availability") result = { data: state.attendants, error: null };
        else if (table === "conversations" && q.count) result = { count: state.queuePositionCount, error: null };
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  };
  return {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: fn === "fn_channel_routing_claim" ? state.claimResult ?? "assigned" : null, error: null });
    },
  };
}

function makeCtx(state: StubState): McpContext {
  return {
    organizationId: ORG_ID,
    role: "agent",
    actor: { type: "user", id: AGENT_ID },
    apiTokenId: "tok",
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: makeSupabaseStub(state) as any,
  } as McpContext;
}

function stubState(over: Partial<StubState> = {}): StubState {
  return {
    attendants: [{ user_id: AGENT_ID, capacity: 5, schedule: {} }],
    queuePositionCount: 4,
    rpcCalls: [],
    updates: [],
    inserts: [],
    ...over,
  };
}

const baseInput = {
  conversation_id: CONV_ID,
  reason: "cliente pediu humano",
  urgency: "normal" as const,
  target_user_id: undefined,
  metadata: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(triggerHandoff).mockResolvedValue({ triggered: true, reason: "requested_human" });
});

describe("crm_request_human_handoff v2 (INB-12 — roteamento G5 unificado)", () => {
  it("com elegível: selectRoundRobin determinístico ⇒ fn_channel_routing_claim reason='handoff'", async () => {
    const state = stubState();
    const result = (await crmRequestHumanHandoff.handler(baseInput, makeCtx(state))) as {
      assigned_to: string | null;
      queued: boolean;
      position: number | null;
    };

    expect(state.rpcCalls).toEqual([
      {
        fn: "fn_channel_routing_claim",
        args: {
          p_org: ORG_ID, p_conversation: CONV_ID, p_channel: CONV_ID, p_user: AGENT_ID,
          p_reason: "handoff", p_schedule: {},
        },
      },
    ]);
    expect(result.assigned_to).toBe(AGENT_ID);
    expect(result.queued).toBe(false);
    expect(result.position).toBeNull();
    expect(state.inserts).toEqual([]);
  });

  it("target_user_id elegível ⇒ atribui ao alvo (não ao rodízio)", async () => {
    const state = stubState({
      attendants: [
        { user_id: AGENT_ID, capacity: 5, schedule: {} },
        { user_id: AGENT_B, capacity: 5, schedule: {} },
      ],
    });
    const result = (await crmRequestHumanHandoff.handler(
      { ...baseInput, target_user_id: AGENT_B },
      makeCtx(state),
    )) as { assigned_to: string | null };

    expect(state.rpcCalls[0]?.args.p_user).toBe(AGENT_B);
    expect(result.assigned_to).toBe(AGENT_B);
  });

  it("sem elegível: fila — kind limpo + evento reason='handoff' + queued+position", async () => {
    const state = stubState({ attendants: [], queuePositionCount: 4 });
    const result = (await crmRequestHumanHandoff.handler(baseInput, makeCtx(state))) as {
      assigned_to: string | null;
      queued: boolean;
      position: number | null;
    };

    expect(result.assigned_to).toBeNull();
    expect(result.queued).toBe(true);
    expect(result.position).toBe(4);
    expect(state.rpcCalls).toEqual([{ fn: "fn_request_channel_routing", args: { p_org: ORG_ID, p_conversation: CONV_ID } }]);
    expect(state.updates).toContainEqual({
      table: "conversations",
      values: { assignee_kind: null },
    });
    expect(state.inserts).toEqual([]);
  });
  it("alvo fora da política não recebe; lista vazia permanece na fila", async () => {
    const state = stubState({ allowed: [] });
    const result = await crmRequestHumanHandoff.handler({ ...baseInput, target_user_id: AGENT_ID }, makeCtx(state));
    expect(result).toMatchObject({ assigned_to: null, queued: true });
    expect(state.rpcCalls.some(c => c.fn === "fn_channel_routing_claim")).toBe(false);
  });
  it("perda por revogação no claim não troca por alguém fora da lista", async () => {
    const state = stubState({ allowed: [AGENT_ID], claimResult: "candidate_revoked" });
    expect(await crmRequestHumanHandoff.handler(baseInput, makeCtx(state))).toMatchObject({ assigned_to: null, queued: true });
    expect(state.rpcCalls.filter(c => c.fn === "fn_channel_routing_claim")).toHaveLength(1);
    expect(state.rpcCalls.at(-1)?.fn).toBe("fn_request_channel_routing");
  });

});
