import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const org = "11111111-1111-4111-8111-111111111111";
const canal = "22222222-2222-4222-8222-222222222222";
const telefone = "+5511999998888";
const filters: Record<string, unknown> = {};
const rpc = vi.fn();
const row = { id: canal, organization_id: org, archived_at: null, metadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [telefone], segredo_do_transporte: "nao-expor" } };
const context = (id = canal) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = {}) => new NextRequest("http://localhost/api/v1/channel-sessions/" + canal + "/ai-access", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  for (const k of Object.keys(filters)) delete filters[k];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: org }, org: { orgId: org, role: "admin" } } as Awaited<ReturnType<typeof requireRole>>);
  const query = {
    select: () => query,
    eq: (k: string, v: unknown) => { filters[k] = v; return query; },
    is: (k: string, v: unknown) => { filters[k] = v; return query; },
    maybeSingle: async () => ({ data: Object.entries(filters).every(([k,v]) => row[k as keyof typeof row] === v) ? row : null, error: null }),
  };
  rpc.mockResolvedValue({ data: 1, error: null });
  vi.mocked(createAdminClient).mockReturnValue({ from: () => query, rpc } as unknown as ReturnType<typeof createAdminClient>);
});

describe("configuração de acesso da IA", () => {
  it("exige admin tanto para ler quanto para escrever e não consulta DB se negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    expect((await GET(req(), context())).status).toBe(403);
    expect((await PATCH(req(), context())).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ allowPlatformAdmin: true }));
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it("suporte readonly nega a mutação antes de service role e auditoria", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({ id: org, is_platform_admin: true,
      support: { organization_id: org, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    const response = await PATCH(req({ mode: "open", test_phone_numbers: [] }), context());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
    expect(requireRole).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("retorna somente modo e telefones, com escopo de organização e canal ativo", async () => {
    const response = await GET(req(), context());
    expect((await response.json()).data).toEqual({ mode: "pre_go_live", test_phone_numbers: [telefone] });
    expect(filters).toEqual({ organization_id: org, id: canal, archived_at: null });
    expect((await GET(req(), context(org))).status).toBe(404);
  });
  it("normaliza a lista, ignora organização do body e audita sem telefone", async () => {
    const response = await PATCH(req({ mode: "pre_go_live", test_phone_numbers: ["+55 (11) 99999-8888", telefone], organization_id: canal }), context());
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_configurar_pre_go_live_canal", { p_org: org, p_canal: canal, p_modo: "pre_go_live", p_numeros: [telefone] });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.ai_access_updated", metadata: { mode: "pre_go_live", test_phone_numbers_count: 1 } }));
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(telefone);
  });
  it("recusa lista ou modo inválido sem alteração", async () => {
    for (const body of [{ mode: "open" }, { mode: "allowlist", test_phone_numbers: [] }, { mode: "open", test_phone_numbers: ["abc5511999998888"] }]) {
      expect((await PATCH(req(body), context())).status).toBe(422);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("não anuncia sucesso nem audita falha de banco ou canal ausente", async () => {
    rpc.mockResolvedValueOnce({ data: 0, error: null });
    expect((await PATCH(req({ mode: "open", test_phone_numbers: [] }), context())).status).toBe(404);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "rpc ausente" } });
    expect((await PATCH(req({ mode: "open", test_phone_numbers: [] }), context())).status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
