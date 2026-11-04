/* eslint-disable @typescript-eslint/no-explicit-any -- controlled transport doubles, validated separately against real PostgreSQL/PostgREST */
import { beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ db: null as any }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => s.db }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn().mockResolvedValue({ ok: true }),
}));
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { processEvent } from "@/lib/routing/worker";
const O = "ab000000-0000-4000-8000-000000000001",
  C = "ab000000-0000-4000-8000-000000000002",
  T = "ab000000-0000-4000-8000-000000000003",
  H = "ab000000-0000-4000-8000-000000000004";
function db(
  opts: { configured?: boolean; status?: string; rule?: boolean; handoff?: boolean } = {},
) {
  const calls: any[] = [];
  const read = (table: string) => ({
    data:
      table === "contacts"
        ? { name: "Synthetic", is_personal: false }
        : table === "conversations"
          ? {
              id: C,
              organization_id: O,
              contact_id: T,
              channel_session_id: H,
              status: "ai_handling",
              service_revision: 1,
              assigned_to_user_id: null,
              bot_silenced_until: opts.handoff ? "infinity" : null,
            }
          : table === "organizations"
            ? {
                settings: {
                  routing: { mode: "manual" },
                  handoff_delivery: { enabled: !!opts.handoff },
                },
              }
            : table === "handoff_delivery_episodes"
              ? opts.handoff
                ? [{ id: "episode" }]
                : []
              : table === "commercial_routing_rules"
                ? opts.rule === false
                  ? null
                  : { channel_id: H }
                : null,
    error: null,
  });
  const from = vi.fn((table: string) => {
    const q: any = {};
    for (const method of ["select", "eq", "is", "in", "limit", "order", "or", "lte", "update"])
      q[method] = vi.fn((...args: any[]) => {
        calls.push({ table, method, args });
        return q;
      });
    q.maybeSingle = vi.fn(async () => read(table));
    q.then = (a: any, b: any) => Promise.resolve(read(table)).then(a, b);
    return q;
  });
  const rpc = vi.fn(async (name: string, args: any) => {
    calls.push({ rpc: name, args });
    return {
      data: {
        configured: opts.configured !== false,
        status: opts.status ?? "assigned",
        lead_id: "synthetic-lead",
      },
      error: null,
    };
  });
  return { from, rpc, calls };
}
beforeEach(() => vi.clearAllMocks());
it("native entry forwards exact server org/conversation and never calls human claim", async () => {
  s.db = db();
  await garantirLeadDaConversa(s.db, {
    organizationId: O,
    contactId: T,
    conversationId: C,
    nomeDoContato: "Synthetic",
  });
  expect(s.db.rpc).toHaveBeenCalledWith("fn_commercial_ingress", { p_org: O, p_conversation: C });
  expect(
    s.db.rpc.mock.calls.some(
      ([name]: any[]) => name === "fn_channel_routing_claim" || name === "fn_conversation_assign",
    ),
  ).toBe(false);
});
it("default off continues original lead lookup", async () => {
  s.db = db({ configured: false });
  await garantirLeadDaConversa(s.db, {
    organizationId: O,
    contactId: T,
    conversationId: C,
    nomeDoContato: "Synthetic",
  });
  expect(s.db.from).toHaveBeenCalledWith("crm_leads");
});
it("commercial rule skips human routing without mutating conversation", async () => {
  s.db = db();
  const out = await processEvent(
    {
      id: "event",
      organization_id: O,
      payload: { organization_id: O, conversation_id: C },
      metadata: null,
      consumed_by: [],
      attempts: 0,
    },
    new Date(),
  );
  expect(out).toBe("skipped_commercial_observation");
  expect(s.db.rpc.mock.calls.map(([name]: any[]) => name)).toEqual(["fn_commercial_ingress"]);
  expect(s.db.calls.some((c: any) => c.table === "conversations" && c.method === "update")).toBe(
    false,
  );
});
it("pending no eligible must remain retryable, not marked done", async () => {
  s.db = db({ status: "pending_no_eligible" });
  const out = await processEvent(
    {
      id: "event",
      organization_id: O,
      payload: { organization_id: O, conversation_id: C },
      metadata: null,
      consumed_by: [],
      attempts: 0,
    },
    new Date(),
  );
  expect(out).toBe("requeued_no_eligible");
});
it("native entry reports newly created receipt factually without duplicate JS events", async () => {
  s.db = db();
  s.db.rpc.mockResolvedValueOnce({
    data: {
      configured: true,
      status: "assigned",
      created: true,
      lead_id: "new-lead",
      pipeline_id: "configured-pipeline",
      stage_id: "configured-stage",
    },
    error: null,
  });
  const out = await garantirLeadDaConversa(s.db, {
    organizationId: O,
    contactId: T,
    conversationId: C,
    nomeDoContato: "Synthetic",
  });
  expect(out).toEqual({
    criado: true,
    leadId: "new-lead",
    pipelineId: "configured-pipeline",
    stageId: "configured-stage",
  });
  expect(s.db.rpc.mock.calls.map(([name]: any[]) => name)).toEqual(["fn_commercial_ingress"]);
});
