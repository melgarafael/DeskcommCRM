import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  support: vi.fn(),
  admin: vi.fn(),
  pool: vi.fn(),
  write: vi.fn(),
  http: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: mocks.pool }));
vi.mock("@/lib/ai/agents/router-members", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agents/router-members")>()),
  writeRouterMembers: mocks.write,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
import { PUT } from "@/app/api/v1/ai/routers/[id]/members/route";
import { replaceRouterMembersHttp } from "@/lib/ai/agents/router-members-http";
import { NextRequest } from "next/server";
const id = "10000000-0000-4000-8000-000000000001";
const member = { agent_id: id, intent_name: "vendas", intent_description: "Vendas", examples: [] };
function httpDatabase(insertFails = false, foreignAgent = false) {
  const mutations: string[] = [];
  const from = vi.fn((table: string) => {
    let operation = "read";
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      maybeSingle: async () => ({ data: { id }, error: null }),
      upsert: () => {
        operation = "restore";
        mutations.push(operation);
        return chain;
      },
      insert: () => {
        operation = "insert";
        mutations.push(operation);
        return chain;
      },
      delete: () => {
        operation = "delete";
        mutations.push(operation);
        return chain;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "ai_agents"
              ? foreignAgent
                ? []
                : [{ id }]
              : [{ id: "obsolete", intent_name: "antiga" }],
          error: operation === "insert" && insertFails ? new Error("insert failed") : null,
        }).then(resolve),
    };
    return chain;
  });
  return { admin: { from } as unknown as SupabaseClient, mutations };
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.support.mockResolvedValue(null);
  mocks.guard.mockResolvedValue({ ok: true, user: { id, idioma: "pt" }, org: { orgId: id } });
});
function request() {
  return new NextRequest("http://localhost/api/v1/ai/routers/test/members", {
    method: "PUT",
    body: JSON.stringify({ members: [member] }),
  });
}
it("uses the transactional shared lock when a DB URL is configured", async () => {
  vi.stubEnv("SUPABASE_DB_URL", "postgresql://local-test");
  const db = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  mocks.pool.mockReturnValue({ connect: async () => db });
  const response = await PUT(request(), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  // O schema completa `flow_pointer_id` (null) — o vínculo com o roteiro (#1573, B2).
  expect(mocks.write).toHaveBeenCalledWith(db, id, id, [{ ...member, flow_pointer_id: null }], "replace");
  expect(db.query.mock.calls.map(([sql]) => sql)).toEqual(["begin", "commit"]);
  expect(mocks.admin).not.toHaveBeenCalled();
});
it("preserves the HTTP-only route without opening a Postgres connection", async () => {
  vi.stubEnv("SUPABASE_DB_URL", "");
  const db = httpDatabase();
  mocks.admin.mockReturnValue(db.admin);
  const response = await PUT(request(), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  expect(mocks.pool).not.toHaveBeenCalled();
  expect(db.mutations).toEqual(["delete", "insert"]);
});
it("restores previous members when the HTTP insertion fails", async () => {
  const db = httpDatabase(true);
  await expect(replaceRouterMembersHttp(db.admin, id, id, [member])).rejects.toThrow(
    "insert failed",
  );
  expect(db.mutations).toEqual(["delete", "insert", "restore"]);
});
it("validates tenant membership before any HTTP mutation", async () => {
  const db = httpDatabase(false, true);
  await expect(replaceRouterMembersHttp(db.admin, id, id, [member])).rejects.toThrow(
    "member_agent_not_found",
  );
  expect(db.mutations).toEqual([]);
});
