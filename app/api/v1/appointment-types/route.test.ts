import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { GET, POST } from "./route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function reqOk(role: "manager" | "agent" = "manager") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

function stubAdmin(rows: unknown[] = [], insertResult: { data: unknown; error: unknown } = { data: { id: "novo-id" }, error: null }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
    insert: () => ({
      select: () => ({ single: () => Promise.resolve(insertResult) }),
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/appointment-types", () => {
  it("exige role — sem sessão válida, devolve a resposta do requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }) as never,
    });
    const res = await GET(new Request("http://x/api/v1/appointment-types") as never);
    expect(res.status).toBe(401);
  });

  it("lista os tipos da organização ativa", async () => {
    reqOk("agent");
    stubAdmin([{ id: "t1", name: "Consulta", duration_minutes: 30 }]);
    const res = await GET(new Request("http://x/api/v1/appointment-types") as never);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual([{ id: "t1", name: "Consulta", duration_minutes: 30 }]);
  });
});

describe("POST /api/v1/appointment-types", () => {
  it("exige manager+ (viewer/agent não pode criar tipo)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) as never,
    });
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({}) }) as never,
    );
    expect(res.status).toBe(403);
  });

  it("cria o tipo com payload válido", async () => {
    reqOk("manager");
    stubAdmin();
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          name: "Consulta",
          duration_minutes: 30,
          responsible_user_id: USER_ID,
        }),
      }) as never,
    );
    expect(res.status).toBe(201);
  });

  it("rejeita payload sem name", async () => {
    reqOk("manager");
    stubAdmin();
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ duration_minutes: 30, responsible_user_id: USER_ID }),
      }) as never,
    );
    expect(res.status).toBe(422);
  });
});
