/**
 * Task 4.2 — REST API do enrollment manual (`/api/v1/ai/followups/enrollments`).
 *
 * Prova contra os Route Handlers REAIS (auth e Supabase mockados, mesmo
 * padrão de `tests/api/followup-flows.test.ts`): RBAC, Zod strict,
 * flow_not_active (pointer draft/disabled ou sem active_version_id),
 * contato de outra org → 404, 23505 → 409, resolução do nó trigger da
 * version pinada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import type { FlowGraph, FlowNode, FlowEdge } from "@/lib/followup/graph-schema";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "22222222-2222-4222-8222-999999999999";
const POINTER_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";

const pos = { x: 0, y: 0 };
function trigger(id: string): FlowNode {
  return { id, type: "trigger", label: id, position: pos, config: {} };
}
function end(id: string): FlowNode {
  return { id, type: "end", label: id, position: pos, config: { outcome: "exhausted" } };
}
function edge(id: string, source: string, target: string): FlowEdge {
  return { id, source, target, priority: 0, condition: { type: "always" } };
}
const GRAPH: FlowGraph = {
  nodes: [trigger("t1"), end("e1")],
  edges: [edge("edge1", "t1", "e1")],
};

type Row = Record<string, unknown>;

function makeDb(pointers: Row[], versions: Row[], contacts: Row[], enrollments: Row[] = []) {
  const tables: Record<string, Row[]> = {
    followup_flow_pointers: pointers,
    followup_flow_versions: versions,
    contacts,
    followup_enrollments: enrollments,
  };

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let mode: "select" | "insert" = "select";
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
      // insert
      const row: Row = {
        id: randomUUID(),
        status: "active",
        next_eval_at: new Date().toISOString(),
        outcome: null,
        completed_at: null,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...payload,
      };
      if (table === "followup_enrollments") {
        const liveStatuses = ["active", "waiting_reply", "paused_handoff"];
        const dup = tableRows.some(
          (r) =>
            r.pointer_id === row.pointer_id &&
            r.contact_id === row.contact_id &&
            liveStatuses.includes(r.status as string),
        );
        if (dup) return { data: null, error: { code: "23505", message: "duplicate live enrollment" } };
      }
      tableRows.push(row);
      return { data: [row], error: null };
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

  return { from: (table: string) => builder(table) };
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
}

function req(method: string, body?: Record<string, unknown>, search = "") {
  return new NextRequest(`http://localhost/api/v1/ai/followups/enrollments${search}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function activePointer(overrides: Row = {}): Row {
  return { id: POINTER_ID, organization_id: ORG_ID, status: "active", active_version_id: VERSION_ID, ...overrides };
}
function version(overrides: Row = {}): Row {
  return { id: VERSION_ID, organization_id: ORG_ID, pointer_id: POINTER_ID, graph: GRAPH, ...overrides };
}
function contact(overrides: Row = {}): Row {
  return { id: CONTACT_ID, organization_id: ORG_ID, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/followups/enrollments", () => {
  it("agent (< manager) → 403, sem insert", async () => {
    const db = makeDb([activePointer()], [version()], [contact()]);
    session("agent", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(403);
  });

  it("body inválido (pointer_id não é uuid) → 422 validation_failed", async () => {
    const db = makeDb([activePointer()], [version()], [contact()]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: "not-a-uuid", contact_id: CONTACT_ID }));
    expect(res.status).toBe(422);
  });

  it("pointer inexistente na org → 404", async () => {
    const db = makeDb([], [], [contact()]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(404);
  });

  it("pointer de outra org → 404 (nunca vaza flow_not_active)", async () => {
    const db = makeDb([activePointer({ organization_id: OTHER_ORG_ID })], [version()], [contact()]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(404);
  });

  it("pointer status='draft' → 422 flow_not_active", async () => {
    const db = makeDb([activePointer({ status: "draft", active_version_id: null })], [], [contact()]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("flow_not_active");
  });

  it("pointer status='disabled' → 422 flow_not_active mesmo com active_version_id presente", async () => {
    const db = makeDb([activePointer({ status: "disabled" })], [version()], [contact()]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("flow_not_active");
  });

  it("contato inexistente na org → 404", async () => {
    const db = makeDb([activePointer()], [version()], []);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(404);
  });

  it("contato de outra org → 404", async () => {
    const db = makeDb([activePointer()], [version()], [contact({ organization_id: OTHER_ORG_ID })]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(404);
  });

  it("happy path → 201, current_node_id resolvido pro nó trigger do grafo pinado", async () => {
    const db = makeDb([activePointer()], [version()], [contact()]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Row };
    expect(body.data.current_node_id).toBe("t1");
    expect(body.data.status).toBe("active");
    expect(body.data.version_id).toBe(VERSION_ID);
    expect(body.data.next_eval_at).toBeTruthy();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_enrollment.created" }),
    );
  });

  it("enrollment vivo já existe (23505) → 409 conflict", async () => {
    const existing = { id: randomUUID(), pointer_id: POINTER_ID, contact_id: CONTACT_ID, status: "active" };
    const db = makeDb([activePointer()], [version()], [contact()], [existing]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("enrollment anterior já 'completed' (não é vivo) → novo insert passa, sem 409", async () => {
    const finished = { id: randomUUID(), pointer_id: POINTER_ID, contact_id: CONTACT_ID, status: "completed" };
    const db = makeDb([activePointer()], [version()], [contact()], [finished]);
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await POST(req("POST", { pointer_id: POINTER_ID, contact_id: CONTACT_ID }));
    expect(res.status).toBe(201);
  });
});

describe("GET /api/v1/ai/followups/enrollments", () => {
  it("viewer (any member) → 200, só enrollments da própria org", async () => {
    const rows = [
      { id: "a", organization_id: ORG_ID, pointer_id: POINTER_ID, contact_id: CONTACT_ID, status: "active", updated_at: "2026-01-01" },
      { id: "b", organization_id: OTHER_ORG_ID, pointer_id: POINTER_ID, contact_id: CONTACT_ID, status: "active", updated_at: "2026-01-01" },
    ];
    const db = makeDb([], [], [], rows);
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Row[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe("a");
  });

  it("?status= inválido → 400", async () => {
    const db = makeDb([], [], []);
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await GET(req("GET", undefined, "?status=bogus"));
    expect(res.status).toBe(400);
  });

  it("?status=completed filtra", async () => {
    const rows = [
      { id: "a", organization_id: ORG_ID, pointer_id: POINTER_ID, contact_id: CONTACT_ID, status: "active", updated_at: "2026-01-01" },
      { id: "b", organization_id: ORG_ID, pointer_id: POINTER_ID, contact_id: CONTACT_ID, status: "completed", updated_at: "2026-01-01" },
    ];
    const db = makeDb([], [], [], rows);
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followups/enrollments/route");
    const res = await GET(req("GET", undefined, "?status=completed"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Row[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe("b");
  });
});
