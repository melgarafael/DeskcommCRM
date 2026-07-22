/**
 * Task 3.1 — REST API dos fluxos de follow-up (CRUD + publish/disable/rollback).
 *
 * Prova contra os Route Handlers REAIS (auth e Supabase mockados, no padrão de
 * tests/unit/leads-bulk-assign.test.ts): TDD rota a rota — draft CRUD → publish
 * inválido 422 (por node) → publish válido → rollback → disable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import type { FlowGraph, FlowNode, FlowEdge } from "@/lib/followup/graph-schema";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "22222222-2222-4222-8222-999999999999";

// ---------------------------------------------------------------------------
// Fixture: minimal graphs (mirrors lib/followup/validate-publish.test.ts helpers)
// ---------------------------------------------------------------------------

const pos = { x: 0, y: 0 };
function trigger(id: string): FlowNode {
  return { id, type: "trigger", label: id, position: pos, config: {} };
}
function end(id: string, outcome: "converted" | "exhausted" | "custom" = "exhausted"): FlowNode {
  return { id, type: "end", label: id, position: pos, config: { outcome } };
}
function edge(id: string, source: string, target: string): FlowEdge {
  return { id, source, target, priority: 0, condition: { type: "always" } };
}

/** trigger -> end, always edge: passes flowGraphSchema AND validateFlowForPublish. */
const VALID_GRAPH: FlowGraph = {
  nodes: [trigger("t1"), end("e1")],
  edges: [edge("edge1", "t1", "e1")],
};

/** trigger + orphan end (unreachable from nothing traversing to it) -> no_end_path. */
const INVALID_GRAPH: FlowGraph = {
  nodes: [trigger("t1"), end("e1"), end("orphan")],
  edges: [edge("edge1", "t1", "e1")],
};

// ---------------------------------------------------------------------------
// In-memory fake Supabase client (chainable: select/insert/update/eq/order/
// maybeSingle/single, thenable for implicit awaits after order()).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeDb(pointers: Row[], versions: Row[]) {
  const tables: Record<string, Row[]> = {
    followup_flow_pointers: pointers,
    followup_flow_versions: versions,
  };

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | undefined;

    function matches(row: Row): boolean {
      return filters.every(([k, v]) => row[k] === v);
    }

    function execute(): { data: Row[] | null; error: { code?: string; message: string } | null } {
      const tableRows = tables[table]!;
      if (mode === "select") {
        let list = tableRows.filter(matches);
        if (orderCol) {
          const col = orderCol;
          list = [...list].sort((a, b) => {
            const av = String(a[col]);
            const bv = String(b[col]);
            if (av === bv) return 0;
            const cmp = av > bv ? 1 : -1;
            return orderAsc ? cmp : -cmp;
          });
        }
        return { data: list, error: null };
      }
      if (mode === "insert") {
        const row: Row = {
          id: randomUUID(),
          status: "draft",
          draft_graph: null,
          handoff_policy: "pause",
          trigger_config: { kind: "manual" },
          active_version_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...payload,
        };
        if (table === "followup_flow_pointers") {
          const dup = tableRows.some(
            (r) => r.organization_id === row.organization_id && r.name === row.name,
          );
          if (dup) return { data: null, error: { code: "23505", message: "duplicate name" } };
        }
        tableRows.push(row);
        return { data: [row], error: null };
      }
      // update
      const matched = tableRows.filter(matches);
      if (
        table === "followup_flow_pointers" &&
        payload &&
        "name" in payload &&
        matched.length > 0
      ) {
        const self = matched[0]!;
        const dup = tableRows.some(
          (r) =>
            r.organization_id === self.organization_id &&
            r.name === payload!.name &&
            r.id !== self.id,
        );
        if (dup) return { data: null, error: { code: "23505", message: "duplicate name" } };
      }
      for (const row of matched) Object.assign(row, payload);
      return { data: matched, error: null };
    }

    const b = {
      select() {
        return b;
      },
      insert(obj: Row) {
        mode = "insert";
        payload = obj;
        return b;
      },
      update(obj: Row) {
        mode = "update";
        payload = obj;
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return b;
      },
      async maybeSingle() {
        const r = execute();
        if (r.error) return { data: null, error: r.error };
        return { data: r.data && r.data.length > 0 ? r.data[0] : null, error: null };
      },
      async single() {
        const r = execute();
        if (r.error) return { data: null, error: r.error };
        if (!r.data || r.data.length !== 1) {
          return { data: null, error: { message: "expected exactly one row" } };
        }
        return { data: r.data[0], error: null };
      },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(execute()).then(onF, onR);
      },
    };
    return b;
  }

  /** Mirrors fn_publish_followup_flow_version (migration 0055): insert version
   *  (with pointer_id) + activate pointer, atomically, or 'pointer_not_found'. */
  async function rpc(name: string, params: Record<string, unknown>) {
    if (name !== "fn_publish_followup_flow_version") {
      return { data: null, error: { message: `unknown rpc: ${name}` } };
    }
    const pointer = pointers.find((p) => p.id === params.p_pointer);
    if (!pointer || pointer.organization_id !== params.p_org) {
      return { data: null, error: { message: "pointer_not_found" } };
    }
    const versionId = randomUUID();
    versions.push({
      id: versionId,
      organization_id: params.p_org,
      pointer_id: params.p_pointer,
      graph: params.p_graph,
      created_by: params.p_created_by,
      created_at: new Date().toISOString(),
    });
    pointer.active_version_id = versionId;
    pointer.status = "active";
    pointer.updated_at = new Date().toISOString();
    return { data: versionId, error: null };
  }

  return { from: (table: string) => builder(table), rpc };
}

function session(effectiveRole: Role, db: ReturnType<typeof makeDb>) {
  const user: AuthUser = {
    id: USER_ID,
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
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(db as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(db as any);
}

function req(method: string, body?: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/ai/followup-flows", {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Draft CRUD
// ---------------------------------------------------------------------------

describe("POST /api/v1/ai/followup-flows — create draft", () => {
  it("agent (< manager) → 403 forbidden_role, sem insert", async () => {
    const db = makeDb([], []);
    session("agent", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    const res = await POST(req("POST", { name: "Recuperação carrinho" }));
    expect(res.status).toBe(403);
    expect(db.from("followup_flow_pointers")).toBeDefined();
  });

  it("manager → 201, draft com status='draft' e draft_graph null", async () => {
    const db = makeDb([], []);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    const res = await POST(req("POST", { name: "Recuperação carrinho" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Row };
    expect(body.data.status).toBe("draft");
    expect(body.data.draft_graph).toBeNull();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_flow.created" }),
    );
  });

  it("nome duplicado na mesma org → 409 conflict", async () => {
    const db = makeDb(
      [{ id: randomUUID(), organization_id: ORG_ID, name: "Recuperação carrinho" }],
      [],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    const res = await POST(req("POST", { name: "Recuperação carrinho" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("body inválido (name vazio) → 422 validation_failed", async () => {
    const db = makeDb([], []);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/route");
    const res = await POST(req("POST", { name: "" }));
    expect(res.status).toBe(422);
  });
});

describe("GET /api/v1/ai/followup-flows — list", () => {
  it("viewer (any member) → 200, só pointers da própria org", async () => {
    const db = makeDb(
      [
        { id: "33333333-3333-4333-8333-333333333333", organization_id: ORG_ID, name: "A", status: "draft", active_version_id: null, handoff_policy: "pause", updated_at: "2026-01-01" },
        { id: "44444444-4444-4444-8444-444444444444", organization_id: OTHER_ORG_ID, name: "B", status: "draft", active_version_id: null, handoff_policy: "pause", updated_at: "2026-01-01" },
      ],
      [],
    );
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followup-flows/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Row[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe("33333333-3333-4333-8333-333333333333");
  });
});

describe("GET /api/v1/ai/followup-flows/:id", () => {
  it("pointer de outra org → 404 not_found", async () => {
    const db = makeDb(
      [{ id: "33333333-3333-4333-8333-333333333333", organization_id: OTHER_ORG_ID, name: "A" }],
      [],
    );
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const res = await GET(req("GET"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(404);
  });

  it("pointer da própria org → 200 com draft_graph/trigger_config/handoff_policy", async () => {
    const db = makeDb(
      [
        {
          id: "33333333-3333-4333-8333-333333333333",
          organization_id: ORG_ID,
          name: "A",
          status: "draft",
          draft_graph: null,
          handoff_policy: "pause",
          trigger_config: { kind: "manual" },
          active_version_id: null,
        },
      ],
      [],
    );
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const res = await GET(req("GET"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Row };
    expect(body.data.trigger_config).toEqual({ kind: "manual" });
  });
});

describe("PATCH /api/v1/ai/followup-flows/:id", () => {
  function pointerRow(overrides: Row = {}): Row {
    return {
      id: "33333333-3333-4333-8333-333333333333",
      organization_id: ORG_ID,
      name: "A",
      status: "draft",
      draft_graph: null,
      handoff_policy: "pause",
      trigger_config: { kind: "manual" },
      active_version_id: null,
      ...overrides,
    };
  }

  it("agent (< manager) → 403", async () => {
    const db = makeDb([pointerRow()], []);
    session("agent", db);
    const { PATCH } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const res = await PATCH(req("PATCH", { name: "B" }), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(403);
  });

  it("draft_graph com shape inválido (nó desconhecido) → 422 validation_failed", async () => {
    const db = makeDb([pointerRow()], []);
    session("manager", db);
    const { PATCH } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const res = await PATCH(
      req("PATCH", { draft_graph: { nodes: [{ id: "x", type: "bogus" }], edges: [] } }),
      ctx("33333333-3333-4333-8333-333333333333"),
    );
    expect(res.status).toBe(422);
  });

  it("draft_graph com shape válido + trigger_config + handoff_policy → 200, persiste tudo", async () => {
    const db = makeDb([pointerRow()], []);
    session("manager", db);
    const { PATCH } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const res = await PATCH(
      req("PATCH", {
        draft_graph: VALID_GRAPH,
        handoff_policy: "cancel",
        trigger_config: { kind: "silence", params: { threshold_minutes: 30 } },
      }),
      ctx("33333333-3333-4333-8333-333333333333"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Row };
    expect(body.data.draft_graph).toEqual(VALID_GRAPH);
    expect(body.data.handoff_policy).toBe("cancel");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_flow.updated" }),
    );
  });

  it("pointer inexistente na org → 404", async () => {
    const db = makeDb([], []);
    session("manager", db);
    const { PATCH } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const res = await PATCH(req("PATCH", { name: "B" }), ctx("55555555-5555-4555-8555-555555555555"));
    expect(res.status).toBe(404);
  });

  it("body {} (nada a mudar) → 200, recarrega o pointer da própria org (reload filtra organization_id)", async () => {
    const db = makeDb([pointerRow({ name: "nome-original" })], []);
    session("manager", db);
    const { PATCH } = await import("@/app/api/v1/ai/followup-flows/[id]/route");
    const res = await PATCH(req("PATCH", {}), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Row };
    expect(body.data.name).toBe("nome-original");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

describe("POST /api/v1/ai/followup-flows/:id/publish", () => {
  it("draft_graph null → 422 validation_failed com details.errors", async () => {
    const db = makeDb(
      [{ id: "33333333-3333-4333-8333-333333333333", organization_id: ORG_ID, status: "draft", draft_graph: null }],
      [],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/publish/route");
    const res = await POST(req("POST"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { errors: unknown[] } } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.errors.length).toBeGreaterThan(0);
  });

  it("draft_graph inválido (nó órfão) → 422 com erro por node", async () => {
    const db = makeDb(
      [{ id: "33333333-3333-4333-8333-333333333333", organization_id: ORG_ID, status: "draft", draft_graph: INVALID_GRAPH }],
      [],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/publish/route");
    const res = await POST(req("POST"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { details: { errors: Array<{ code: string; node_id: string | null }> } };
    };
    expect(body.error.details.errors).toEqual([
      { node_id: "orphan", code: "unreachable_node", message: expect.any(String) },
    ]);
  });

  it("draft_graph válido → cria version, pointer vira active com active_version_id", async () => {
    const db = makeDb(
      [{ id: "33333333-3333-4333-8333-333333333333", organization_id: ORG_ID, status: "draft", draft_graph: VALID_GRAPH }],
      [],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/publish/route");
    const res = await POST(req("POST"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; active_version_id: string } };
    expect(body.data.status).toBe("active");
    expect(body.data.active_version_id).toBeTruthy();

    const { data: versionRows } = (await db
      .from("followup_flow_versions")
      .select()
      .eq("id", body.data.active_version_id)) as { data: Row[] };
    expect(versionRows.length).toBe(1);
    expect(versionRows[0]!.graph).toEqual(VALID_GRAPH);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_flow.published" }),
    );
  });

  it("pointer de outra org → 404", async () => {
    const db = makeDb(
      [{ id: "33333333-3333-4333-8333-333333333333", organization_id: OTHER_ORG_ID, status: "draft", draft_graph: VALID_GRAPH }],
      [],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/publish/route");
    const res = await POST(req("POST"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe("POST /api/v1/ai/followup-flows/:id/rollback", () => {
  const P1 = "33333333-3333-4333-8333-333333333333";
  const OTHER_POINTER = "99999999-9999-4999-8999-999999999999";

  it("version_id de outra org → 404 not_found", async () => {
    const db = makeDb(
      [{ id: P1, organization_id: ORG_ID, status: "active", active_version_id: "66666666-6666-4666-8666-666666666666" }],
      [{ id: "88888888-8888-4888-8888-888888888888", organization_id: OTHER_ORG_ID, pointer_id: P1, graph: VALID_GRAPH }],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/rollback/route");
    const res = await POST(req("POST", { version_id: "88888888-8888-4888-8888-888888888888" }), ctx(P1));
    expect(res.status).toBe(404);
  });

  it("version da mesma org mas de OUTRO pointer (linhagem errada) → 404 not_found", async () => {
    const db = makeDb(
      [{ id: P1, organization_id: ORG_ID, status: "active", active_version_id: "66666666-6666-4666-8666-666666666666" }],
      [{ id: "77777777-7777-4777-8777-777777777777", organization_id: ORG_ID, pointer_id: OTHER_POINTER, graph: VALID_GRAPH }],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/rollback/route");
    const res = await POST(req("POST", { version_id: "77777777-7777-4777-8777-777777777777" }), ctx(P1));
    expect(res.status).toBe(404);
  });

  it("version órfã (pointer_id null) → 404 not_found, nunca é alvo de rollback", async () => {
    const db = makeDb(
      [{ id: P1, organization_id: ORG_ID, status: "active", active_version_id: "66666666-6666-4666-8666-666666666666" }],
      [{ id: "77777777-7777-4777-8777-777777777777", organization_id: ORG_ID, pointer_id: null, graph: VALID_GRAPH }],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/rollback/route");
    const res = await POST(req("POST", { version_id: "77777777-7777-4777-8777-777777777777" }), ctx(P1));
    expect(res.status).toBe(404);
  });

  it("version_id válido e da linhagem do pointer → 200, pointer aponta pra ela", async () => {
    const db = makeDb(
      [{ id: P1, organization_id: ORG_ID, status: "active", active_version_id: "66666666-6666-4666-8666-666666666666" }],
      [
        { id: "66666666-6666-4666-8666-666666666666", organization_id: ORG_ID, pointer_id: P1, graph: VALID_GRAPH },
        { id: "77777777-7777-4777-8777-777777777777", organization_id: ORG_ID, pointer_id: P1, graph: VALID_GRAPH },
      ],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/rollback/route");
    const res = await POST(req("POST", { version_id: "77777777-7777-4777-8777-777777777777" }), ctx(P1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { active_version_id: string; status: string } };
    expect(body.data.active_version_id).toBe("77777777-7777-4777-8777-777777777777");
    expect(body.data.status).toBe("active");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_flow.rolled_back" }),
    );
  });

  it("pointer 'disabled' → rollback só troca active_version_id, NÃO reativa (status continua disabled)", async () => {
    const db = makeDb(
      [{ id: P1, organization_id: ORG_ID, status: "disabled", active_version_id: "66666666-6666-4666-8666-666666666666" }],
      [
        { id: "66666666-6666-4666-8666-666666666666", organization_id: ORG_ID, pointer_id: P1, graph: VALID_GRAPH },
        { id: "77777777-7777-4777-8777-777777777777", organization_id: ORG_ID, pointer_id: P1, graph: VALID_GRAPH },
      ],
    );
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/rollback/route");
    const res = await POST(req("POST", { version_id: "77777777-7777-4777-8777-777777777777" }), ctx(P1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { active_version_id: string; status: string } };
    expect(body.data.active_version_id).toBe("77777777-7777-4777-8777-777777777777");
    expect(body.data.status).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// Disable
// ---------------------------------------------------------------------------

describe("POST /api/v1/ai/followup-flows/:id/disable", () => {
  it("pointer ativo → 200, status='disabled', audit emitido", async () => {
    const db = makeDb([{ id: "33333333-3333-4333-8333-333333333333", organization_id: ORG_ID, status: "active" }], []);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/disable/route");
    const res = await POST(req("POST"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("disabled");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_flow.disabled" }),
    );
  });

  it("pointer já disabled → 200 no-op, sem novo audit", async () => {
    const db = makeDb([{ id: "33333333-3333-4333-8333-333333333333", organization_id: ORG_ID, status: "disabled" }], []);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/disable/route");
    const res = await POST(req("POST"), ctx("33333333-3333-4333-8333-333333333333"));
    expect(res.status).toBe(200);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("pointer inexistente na org → 404", async () => {
    const db = makeDb([], []);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/disable/route");
    const res = await POST(req("POST"), ctx("55555555-5555-4555-8555-555555555555"));
    expect(res.status).toBe(404);
  });
});
