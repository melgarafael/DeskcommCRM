/**
 * G6-01 acceptance 6 — unit por tool nova de governança, contra os handlers REAIS
 * (ctx.supabase stub). Cobre: sucesso, cross-org negado, input inválido,
 * idempotência (assign) e números exatos (queue_status).
 */
import { describe, expect, it, vi } from "vitest";

import {
  crmAssignConversation,
  crmManageTags,
  crmGetQueueStatus,
} from "@/lib/mcp/tools/governance";
import { getQueueStatus } from "@/lib/routing/queue";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "33333333-3333-4333-8333-333333333333";

interface Query {
  table: string;
  select: string | null;
  count: boolean;
  terminal: "maybeSingle" | "then";
}
type Resolver = (q: Query) => { data?: unknown; count?: number; error?: unknown };

interface Captures {
  rpc: Array<{ fn: string; args: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
  rpcResult: { data: unknown; error: unknown };
  /** Resultados de rpc consumidos EM ORDEM (simula corrida); fallback rpcResult. */
  rpcResults?: Array<{ data: unknown; error: unknown }>;
}

function makeSupabase(resolve: Resolver, cap: Captures) {
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
        cap.updates.push({ table, values });
        return chain;
      },
      insert: (values: Record<string, unknown>) => {
        cap.inserts.push({ table, values });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle: () => Promise.resolve(resolve({ ...q, terminal: "maybeSingle" })),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ ...q, terminal: "then" })).then(res),
    };
    return chain;
  };
  return {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      cap.rpc.push({ fn, args });
      const next = cap.rpcResults?.shift();
      return Promise.resolve(next ?? cap.rpcResult);
    },
  };
}

function makeCap(over: Partial<Captures> = {}): Captures {
  return {
    rpc: [],
    updates: [],
    inserts: [],
    rpcResult: { data: [{ id: CONV }], error: null },
    ...over,
  };
}

function makeCtx(resolve: Resolver, cap: Captures): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "run_1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: makeSupabase(resolve, cap) as any,
  } as McpContext;
}

// ---------------------------------------------------------------------------
// crm_assign_conversation
// ---------------------------------------------------------------------------

describe("crm_assign_conversation", () => {
  const convAssigned = (owner: string | null): Resolver => (q) =>
    q.table === "conversations" && q.terminal === "maybeSingle"
      ? { data: { id: CONV, organization_id: ORG, assigned_to_user_id: owner }, error: null }
      : { data: null, error: null };

  it("sucesso: transfere e chama fn_conversation_assign (evento na fn)", async () => {
    const cap = makeCap();
    const res = (await crmAssignConversation.handler(
      { conversation_id: CONV, to_user_id: USER_A, reason: "transfer" },
      makeCtx(convAssigned(null), cap),
    )) as { assigned: boolean; assigned_to_user_id: string | null; idempotent: boolean };

    expect(res.assigned).toBe(true);
    expect(res.idempotent).toBe(false);
    expect(res.assigned_to_user_id).toBe(USER_A);
    expect(cap.rpc).toEqual([
      {
        fn: "fn_conversation_assign",
        args: {
          p_organization_id: ORG,
          p_conversation_id: CONV,
          p_to_user_id: USER_A,
          p_reason: "transfer",
          p_expected_assignee: null,
          p_enforce_expected: true,
        },
      },
    ]);
  });

  it("corrida: 2 assigns idênticos ⇒ optimistic lock deixa 1 evento (2º idempotente)", async () => {
    // Ambos leem o dono antigo (null). 1º rpc vence (1 row+evento); 2º rpc perde
    // o lock (0 rows) e, no recheck, vê o dono já = alvo ⇒ idempotente, SEM 2º evento.
    const raceResolve: Resolver = (q) => {
      if (q.table === "conversations" && q.terminal === "maybeSingle") {
        // fetch inicial lê dono antigo; recheck (select curto) lê o dono já aplicado.
        const owner = q.select === "assigned_to_user_id" ? USER_A : null;
        return { data: { id: CONV, organization_id: ORG, assigned_to_user_id: owner }, error: null };
      }
      return { data: null, error: null };
    };
    const input = { conversation_id: CONV, to_user_id: USER_A, reason: "transfer" as const };

    const capWin = makeCap({ rpcResults: [{ data: [{ id: CONV }], error: null }] });
    const first = (await crmAssignConversation.handler(input, makeCtx(raceResolve, capWin))) as {
      idempotent: boolean;
    };
    expect(first.idempotent).toBe(false);
    expect(capWin.rpc).toHaveLength(1); // 1 chamada ⇒ 1 evento (na fn)

    const capLose = makeCap({ rpcResults: [{ data: [], error: null }] }); // perdeu o lock
    const second = (await crmAssignConversation.handler(input, makeCtx(raceResolve, capLose))) as {
      idempotent: boolean;
      assigned_to_user_id: string | null;
    };
    expect(second.idempotent).toBe(true); // recheck: dono já = alvo ⇒ sem evento novo
    expect(second.assigned_to_user_id).toBe(USER_A);
  });

  it("idempotente: já está com o dono alvo ⇒ não duplica evento (sem rpc)", async () => {
    const cap = makeCap();
    const res = (await crmAssignConversation.handler(
      { conversation_id: CONV, to_user_id: USER_A, reason: "transfer" },
      makeCtx(convAssigned(USER_A), cap),
    )) as { idempotent: boolean };

    expect(res.idempotent).toBe(true);
    expect(cap.rpc).toEqual([]);
  });

  it("cross-org negado: fn RAISE (guard INB-06a) ⇒ erro", async () => {
    const cap = makeCap({ rpcResult: { data: null, error: { message: "destino não é membro" } } });
    await expect(
      crmAssignConversation.handler(
        { conversation_id: CONV, to_user_id: USER_B, reason: "transfer" },
        makeCtx(convAssigned(null), cap),
      ),
    ).rejects.toThrow(/membro/);
  });

  it("input inválido: to_user_id null com reason=transfer ⇒ ZodError", async () => {
    const cap = makeCap();
    await expect(
      crmAssignConversation.handler(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { conversation_id: CONV, to_user_id: null, reason: "transfer" } as any,
        makeCtx(convAssigned(null), cap),
      ),
    ).rejects.toThrow();
    expect(cap.rpc).toEqual([]);
  });

  it("conversa de outra org (não encontrada no filtro) ⇒ erro", async () => {
    const cap = makeCap();
    await expect(
      crmAssignConversation.handler(
        { conversation_id: CONV, to_user_id: USER_A, reason: "transfer" },
        makeCtx(() => ({ data: null, error: null }), cap),
      ),
    ).rejects.toThrow(/conversation_not_found/);
  });
});

// ---------------------------------------------------------------------------
// crm_manage_tags
// ---------------------------------------------------------------------------

describe("crm_manage_tags", () => {
  const withTags = (table: string, tags: string[] | null): Resolver => (q) =>
    q.terminal === "maybeSingle" && q.table === table
      ? { data: { id: CONV, tags }, error: null }
      : { data: null, error: null };

  it("add/remove normaliza (lowercase) e persiste; audit action por kind", async () => {
    const cap = makeCap();
    const res = (await crmManageTags.handler(
      { target_kind: "conversation", target_id: CONV, add: ["VIP"], remove: ["a"] },
      makeCtx(withTags("conversations", ["a", "b"]), cap),
    )) as { tags: string[] };

    expect(res.tags.sort()).toEqual(["b", "vip"]);
    expect(cap.updates).toContainEqual({ table: "conversations", values: { tags: ["b", "vip"] } });
  });

  it("contact: usa tabela contacts", async () => {
    const cap = makeCap();
    await crmManageTags.handler(
      { target_kind: "contact", target_id: CONV, add: ["novo"], remove: undefined },
      makeCtx(withTags("contacts", []), cap),
    );
    expect(cap.updates).toContainEqual({ table: "contacts", values: { tags: ["novo"] } });
  });

  it("tag > 40 chars rejeitada", async () => {
    const cap = makeCap();
    await expect(
      crmManageTags.handler(
        { target_kind: "conversation", target_id: CONV, add: ["x".repeat(41)], remove: undefined },
        makeCtx(withTags("conversations", []), cap),
      ),
    ).rejects.toThrow();
  });

  it("> 20 tags rejeitada", async () => {
    const cap = makeCap();
    const existing = Array.from({ length: 20 }, (_, i) => `t${i}`);
    await expect(
      crmManageTags.handler(
        { target_kind: "conversation", target_id: CONV, add: ["extra"], remove: undefined },
        makeCtx(withTags("conversations", existing), cap),
      ),
    ).rejects.toThrow();
  });

  it("alvo inexistente / cross-org ⇒ erro", async () => {
    const cap = makeCap();
    await expect(
      crmManageTags.handler(
        { target_kind: "lead", target_id: CONV, add: ["x"], remove: undefined },
        makeCtx(() => ({ data: null, error: null }), cap),
      ),
    ).rejects.toThrow(/target_not_found/);
  });

  it("sem add nem remove ⇒ erro", async () => {
    const cap = makeCap();
    await expect(
      crmManageTags.handler(
        { target_kind: "conversation", target_id: CONV, add: undefined, remove: undefined },
        makeCtx(withTags("conversations", []), cap),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// crm_get_queue_status
// ---------------------------------------------------------------------------

describe("crm_get_queue_status", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");
  // Fila: 3 conversas esperando 10/20/30s ⇒ avg 20s. 2 atendentes elegíveis.
  const resolve: Resolver = (q) => {
    if (q.table === "conversations" && q.select === "last_inbound_at") {
      return {
        data: [
          { last_inbound_at: new Date(now.getTime() - 10_000).toISOString() },
          { last_inbound_at: new Date(now.getTime() - 20_000).toISOString() },
          { last_inbound_at: new Date(now.getTime() - 30_000).toISOString() },
        ],
        error: null,
      };
    }
    if (q.table === "user_organizations") {
      return { data: [{ user_id: USER_A }, { user_id: USER_B }], error: null };
    }
    if (["channel_sessions", "channel_routing_policies", "channel_routing_responsibles"].includes(q.table)) {
      throw new Error("organization_summary must not resolve an individual channel policy");
    }
    if (q.table === "attendant_availability") {
      return {
        data: [
          { user_id: USER_A, capacity: 5, schedule: {} },
          { user_id: USER_B, capacity: 5, schedule: {} },
        ],
        error: null,
      };
    }
    return { data: [], error: null };
  };

  it("números exatos: queue_size=3, avg_wait_seconds=20, online_eligible_count=2", async () => {
    const cap = makeCap();
    const res = await getQueueStatus(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase(resolve, cap) as any,
      ORG,
      now,
    );
    expect(res).toEqual({ queue_size: 3, avg_wait_seconds: 20, online_eligible_count: 2 });
  });

  it("disponibilidade sem membership ativa não conta como elegível", async () => {
    const onlyA: Resolver = (q) => q.table === "user_organizations"
      ? { data: [{ user_id: USER_A }], error: null } : resolve(q);
    const res = await getQueueStatus(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase(onlyA, makeCap()) as any, ORG, now,
    );
    expect(res).toEqual({ queue_size: 3, avg_wait_seconds: 20, online_eligible_count: 1 });
  });

  it("erro ao ler membership não é publicado como zero elegíveis", async () => {
    const failed: Resolver = (q) => q.table === "user_organizations"
      ? { data: null, error: { message: "membership unavailable" } } : resolve(q);
    await expect(getQueueStatus(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase(failed, makeCap()) as any, ORG, now,
    )).rejects.toThrow("membership unavailable");
  });

  it("tool handler retorna o shape documentado", async () => {
    const cap = makeCap();
    const res = (await crmGetQueueStatus.handler({}, makeCtx(resolve, cap))) as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual([
      "avg_wait_seconds",
      "online_eligible_count",
      "queue_size",
    ]);
  });
});
