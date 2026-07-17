/**
 * G2-01 — matriz role×endpoint aplicada server-side (spec 13 §4).
 *
 * Por grupo de rota: prova o 403 para role insuficiente e o 200 para o role
 * mínimo da matriz, exercitando os Route Handlers REAIS (auth e Supabase
 * mockados; a decisão de autorização é a de produção via requireRole).
 *
 * Grupos cobertos: settings/api-tokens (admin), team (read manager+/write
 * admin), audit (manager+), inbox/conversations (read viewer+/write agent+),
 * leads (read viewer+/write agent+). Billing: nenhuma rota existe hoje —
 * célula admin-only da matriz fica coberta quando a rota nascer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Stub PostgREST: qualquer cadeia .from(t).select()...  resolve com o valor
 * configurado em `tables[t]` (default: lista vazia). `rpc` devolve o role
 * efetivo (fn_user_role_in_org) usado pelo requireRole.
 */
function makeSupabaseStub(role: Role | null, tables: Record<string, unknown> = {}) {
  const chainFor = (table: string) => {
    const result = {
      data: table in tables ? tables[table] : [],
      error: null,
      count: 0,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy(() => proxy, {
      get(_t, prop) {
        if (prop === "then") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
        }
        return () => proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  };
  return {
    auth: {
      getUser: async () =>
        role
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: null },
    },
    from: (table: string) => chainFor(table),
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: role, error: null } : { data: null, error: null },
  };
}

function session(role: Role | null, tables: Record<string, unknown> = {}) {
  const user: AuthUser | null = role
    ? {
        id: USER_ID,
        email: "user@example.com",
        full_name: null,
        avatar_url: null,
        is_platform_admin: false,
        organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
      }
    : null;
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue(
    role ? { orgId: ORG_ID, name: "Org", role } : null,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(makeSupabaseStub(role, tables) as any);
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

const req = (url: string, init?: { method?: string; body?: string }) =>
  new NextRequest(`http://localhost${url}`, init);
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// settings/api-tokens — admin only (spec 13 §4: api_tokens = none abaixo de admin)
// ---------------------------------------------------------------------------
describe("grupo settings/api-tokens (admin)", () => {
  it("GET nega 403 para manager", async () => {
    session("manager");
    const { GET } = await import("@/app/api/v1/settings/api-tokens/route");
    const res = await GET(req("/api/v1/settings/api-tokens"));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
  });

  it("GET permite 200 para admin", async () => {
    session("admin");
    const { GET } = await import("@/app/api/v1/settings/api-tokens/route");
    const res = await GET(req("/api/v1/settings/api-tokens"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// team — read manager+ (nota 7), write admin
// ---------------------------------------------------------------------------
describe("grupo team (read manager+, write admin)", () => {
  it("GET /team nega 403 para agent", async () => {
    session("agent");
    const { GET } = await import("@/app/api/v1/team/route");
    const res = await GET(req("/api/v1/team"));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
  });

  it("GET /team permite 200 para manager", async () => {
    session("manager");
    const { GET } = await import("@/app/api/v1/team/route");
    const res = await GET(req("/api/v1/team"));
    expect(res.status).toBe(200);
  });

  it("PATCH /team/[user_id]/role nega 403 para manager + audita authz.denied", async () => {
    session("manager");
    const { PATCH } = await import("@/app/api/v1/team/[user_id]/role/route");
    const res = await PATCH(
      req("/api/v1/team/x/role", { method: "PATCH", body: JSON.stringify({ role: "admin" }) }),
      params({ user_id: USER_ID }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
    expect(vi.mocked(audit).mock.calls.some(([e]) => e.action === "authz.denied")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audit — manager+ (spec 13 §4 nota 8)
// ---------------------------------------------------------------------------
describe("grupo audit (manager+)", () => {
  it("GET /audit nega 403 para agent", async () => {
    session("agent");
    const { GET } = await import("@/app/api/v1/audit/route");
    const res = await GET(req("/api/v1/audit"));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
  });
});

// ---------------------------------------------------------------------------
// inbox (conversations) — read permite agent; write é agent+ (viewer read-only)
// ---------------------------------------------------------------------------
describe("grupo inbox/conversations (read agent 200, write viewer 403)", () => {
  it("GET /conversations permite 200 para agent", async () => {
    session("agent");
    const { GET } = await import("@/app/api/v1/conversations/route");
    const res = await GET(req("/api/v1/conversations"));
    expect(res.status).toBe(200);
  });

  it("POST /conversations/[id]/claim nega 403 para viewer", async () => {
    session("viewer");
    const { POST } = await import("@/app/api/v1/conversations/[id]/claim/route");
    const res = await POST(
      req("/api/v1/conversations/c1/claim", { method: "POST", body: "{}" }),
      params({ id: "c1" }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
  });

  it("PATCH /conversations/[id] nega 403 para viewer", async () => {
    session("viewer");
    const { PATCH } = await import("@/app/api/v1/conversations/[id]/route");
    const res = await PATCH(
      req("/api/v1/conversations/c1", { method: "PATCH", body: JSON.stringify({ status: "closed" }) }),
      params({ id: "c1" }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
  });
});

// ---------------------------------------------------------------------------
// leads — read permite agent (board); write é agent+ (viewer read-only)
// ---------------------------------------------------------------------------
describe("grupo leads (read agent 200, write viewer 403)", () => {
  it("GET /pipelines/[id]/board permite 200 para agent", async () => {
    session("agent", {
      crm_pipelines: { id: "p1", name: "Pipeline", settings: {} },
      crm_stages: [],
      crm_leads: [],
    });
    const { GET } = await import("@/app/api/v1/pipelines/[id]/board/route");
    const res = await GET(req("/api/v1/pipelines/p1/board"), params({ id: "p1" }));
    expect(res.status).toBe(200);
  });

  it("POST /leads nega 403 para viewer + audita authz.denied", async () => {
    session("viewer");
    const { POST } = await import("@/app/api/v1/leads/route");
    const res = await POST(
      req("/api/v1/leads", { method: "POST", body: JSON.stringify({ name: "X" }) }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
    expect(vi.mocked(audit).mock.calls.some(([e]) => e.action === "authz.denied")).toBe(true);
  });

  it("POST /leads/[id]/move nega 403 para viewer", async () => {
    session("viewer");
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");
    const res = await POST(
      req("/api/v1/leads/l1/move", { method: "POST", body: JSON.stringify({ stage_id: "s1" }) }),
      params({ id: "l1" }),
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden_role");
  });
});
