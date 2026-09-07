import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/ai/inbox/route";
import { PATCH } from "@/app/api/v1/ai/inbox/[id]/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const org = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const item = { id, kind: "handoff", ref_kind: "conversation", ref_id: id, status: "open" };
const calls: string[][] = [];
function client(admin: boolean, readable = false) {
  return { from(table: string) {
    calls.push([admin ? "admin" : "authenticated", table]);
    const chain = {
      select: () => chain, order: () => chain, limit: () => chain,
      eq: (key: string, value: string) => { calls.push([key, value]); return chain; },
      in: () => chain, update: () => chain,
      maybeSingle: async () => ({ data: item, error: null }),
      then: (resolve: (data: unknown) => unknown) => Promise.resolve({ data: admin ? [item] : readable ? [{ id }] : [], error: null, count: 1 }).then(resolve),
    }; return chain;
  } };
}
beforeEach(() => {
  vi.clearAllMocks(); calls.length = 0;
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: org, role: "agent", name: "Org" }, user: { id: "actor" } } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue(client(true) as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(createClient).mockResolvedValue(client(false) as unknown as Awaited<ReturnType<typeof createClient>>);
});
describe("API Central projeta destinos com sessão", () => {
  it("admin lista, JWT autentica destino: zero linha RLS não herda existência do aviso", async () => {
    const response = await GET(new NextRequest("http://localhost/api/v1/ai/inbox"));
    expect(response.status).toBe(200);
    expect((await response.json()).data.items[0].destination.estado).toBe("indisponivel");
    expect(calls.filter(c => c[0] === "admin")).toEqual([["admin", "agent_inbox_items"], ["admin", "agent_inbox_items"]]);
    expect(calls).toContainEqual(["authenticated", "conversations"]);
    expect(calls.filter(c => c[0] === "organization_id")).toEqual(Array(3).fill(["organization_id", org]));
    expect(requireRole).toHaveBeenCalledWith("agent", expect.any(Object));
    expect(audit).not.toHaveBeenCalled();
  });
  it("controle positivo recebe URL apenas pela leitura autenticada", async () => {
    vi.mocked(createClient).mockResolvedValue(client(false, true) as unknown as Awaited<ReturnType<typeof createClient>>);
    const response = await GET(new NextRequest("http://localhost/api/v1/ai/inbox"));
    expect((await response.json()).data.items[0].destination.href).toBe(`/app/inbox/${id}`);
  });
  it.each([401, 403])("nega %i antes de consultar: cookie requerido e viewer não elevado", async status => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status }) } as Awaited<ReturnType<typeof requireRole>>);
    expect((await GET(new NextRequest("http://localhost/api/v1/ai/inbox", { headers: { Authorization: "Bearer dsk_fake" } }))).status).toBe(status);
    expect(createAdminClient).not.toHaveBeenCalled(); expect(createClient).not.toHaveBeenCalled();
  });
  it.each(["resolved", "open"])("PATCH %s continua filtrado e auditado", async status => {
    const response = await PATCH(new NextRequest(`http://localhost/api/v1/ai/inbox/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(calls).toContainEqual(["organization_id", org]);
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "ai.inbox_item_status_changed", organizationId: org, actorUserId: "actor", resourceId: id, metadata: { status } }));
  });
});
