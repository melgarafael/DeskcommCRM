import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { CHANNEL_PROVIDER_SOCIAL, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const org = "11111111-1111-4111-8111-111111111111";
const canal = "22222222-2222-4222-8222-222222222222";
const telefone = "+5511999998888";
const testador = "instagram:6af9e0ef28984e27de07bef4:1011223655361506";
const antigo = "instagram:6af9e0ef28984e27de07bef4:2222";
const filters: Record<string, unknown> = {};
const rpc = vi.fn();
const row = { id: canal, organization_id: org, archived_at: null, provider: CHANNEL_PROVIDER_SOCIAL, metadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [telefone], ai_test_social_identities: [testador, antigo, "lixo"], segredo_do_transporte: "nao-expor" } };
/** Conversas do canal e fichas, como o embed `contacts:contact_id!inner(...)` as devolve. */
const conversas = [
  { contacts: { social_identity: testador, display_name: "WB", name: null } },
  { contacts: { social_identity: testador, display_name: "WB", name: null } },
  { contacts: { social_identity: "telegram:123:456", display_name: "Fora da forma", name: null } },
];
const lidos: string[] = [];
const context = (id = canal) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = {}) => new NextRequest("http://localhost/api/v1/channel-sessions/" + canal + "/ai-access", { method: "PATCH", body: JSON.stringify(body) });
const reqGet = (query = "") => new NextRequest("http://localhost/api/v1/channel-sessions/" + canal + "/ai-access" + query);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  for (const k of Object.keys(filters)) delete filters[k];
  lidos.length = 0;
  row.provider = CHANNEL_PROVIDER_SOCIAL;
  row.metadata.ai_test_social_identities = [testador, antigo, "lixo"];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: org }, org: { orgId: org, role: "admin" } } as Awaited<ReturnType<typeof requireRole>>);
  const query = {
    select: () => query,
    eq: (k: string, v: unknown) => { filters[k] = v; return query; },
    is: (k: string, v: unknown) => { filters[k] = v; return query; },
    maybeSingle: async () => ({ data: Object.entries(filters).every(([k,v]) => row[k as keyof typeof row] === v) ? row : null, error: null }),
  };
  rpc.mockResolvedValue({ data: 1, error: null });
  // Lista de conversas/contatos: thenable, para `await builder` devolver as linhas.
  const lista = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    const q: Record<string, unknown> = {
      select: () => q, order: () => q, limit: () => q, not: () => q,
      eq: (k: string, v: unknown) => { filtros[k] = v; return q; },
      is: () => q,
      in: (k: string, v: unknown) => { filtros[k] = v; return q; },
      then: (res: (v: unknown) => unknown) => {
        lidos.push(tabela + ":" + JSON.stringify(filtros));
        const data = tabela === "conversations" ? conversas
          : [{ social_identity: antigo, display_name: null, name: "Antigo" }];
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return q;
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from: (t: string) => (t === "channel_sessions" ? query : lista(t)), rpc,
  } as unknown as ReturnType<typeof createAdminClient>);
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
  it("retorna somente modo e testadores, com escopo de organização e canal ativo", async () => {
    const response = await GET(req(), context());
    expect((await response.json()).data).toEqual({
      mode: "pre_go_live", test_phone_numbers: [telefone], test_social_identities: [testador, antigo],
    });
    // Sem o pedido explícito, nenhum contato é lido.
    expect(lidos).toEqual([]);
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
  it("oferece como testador social os contatos do PRÓPRIO canal, sem repetir e só na forma aceita", async () => {
    const response = await GET(reqGet("?candidatos=sociais"), context());
    expect(response.status).toBe(200);
    expect((await response.json()).data.social_candidates).toEqual([
      { social_identity: testador, name: "WB" },
      // Na lista, sem conversa recente: aparece para poder ser removido.
      { social_identity: antigo, name: "Antigo" },
    ]);
    expect(lidos[0]).toBe("conversations:" + JSON.stringify({ organization_id: org, channel_session_id: canal }));
    expect(lidos[1]).toBe("contacts:" + JSON.stringify({ organization_id: org, social_identity: [antigo] }));
  });
  it("grava a lista social pela sobrecarga de 5 argumentos e audita só a contagem", async () => {
    const response = await PATCH(req({ mode: "pre_go_live", test_phone_numbers: [], test_social_identities: [testador, testador] }), context());
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_configurar_pre_go_live_canal", {
      p_org: org, p_canal: canal, p_modo: "pre_go_live", p_numeros: [], p_identidades: [testador],
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { mode: "pre_go_live", test_phone_numbers_count: 0, test_social_identities_count: 1 },
    }));
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain("1011223655361506");
  });
  it("sem a lista social no corpo, a gravada não é tocada (sobrecarga de 4 argumentos)", async () => {
    await PATCH(req({ mode: "pre_go_live", test_phone_numbers: [telefone] }), context());
    expect(rpc).toHaveBeenCalledWith("fn_configurar_pre_go_live_canal", {
      p_org: org, p_canal: canal, p_modo: "pre_go_live", p_numeros: [telefone],
    });
  });
  it("recusa identidade social fora da forma sem gravar nada", async () => {
    for (const ids of [["+5511999998888"], ["instagram:curta:1"], ["telegram:6af9e0ef28984e27de07bef4:1"]]) {
      expect((await PATCH(req({ mode: "pre_go_live", test_phone_numbers: [], test_social_identities: ids }), context())).status).toBe(422);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  describe("a lista social só aceita o que a tela oferece para ESTE canal", () => {
    const social = (ids: string[]) => req({ mode: "pre_go_live", test_phone_numbers: [], test_social_identities: ids });
    it("recusa a identidade de OUTRA conta conectada, dizendo qual", async () => {
      const outraPagina = "instagram:aaaaaaaaaaaaaaaaaaaaaaaa:1011223655361506";
      const response = await PATCH(social([testador, outraPagina]), context());
      expect(response.status).toBe(422);
      const { error } = await response.json();
      expect(error.code).toBe("testador_social_recusado");
      expect(error.message).toContain(outraPagina);
      expect(lidos[0]).toBe("conversations:" + JSON.stringify({ organization_id: org, channel_session_id: canal }));
      expect(rpc).not.toHaveBeenCalled();
    });
    it("recusa lista social num canal de WhatsApp", async () => {
      row.provider = DEFAULT_CHANNEL_PROVIDER;
      const response = await PATCH(social([testador]), context());
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("testador_social_recusado");
      expect(rpc).not.toHaveBeenCalled();
    });
    it("mantém a identidade já gravada, mesmo sem conversa recente", async () => {
      const response = await PATCH(social([antigo]), context());
      expect(response.status).toBe(200);
      expect(lidos).toEqual([]);
      expect(rpc).toHaveBeenCalledWith("fn_configurar_pre_go_live_canal", expect.objectContaining({ p_identidades: [antigo] }));
    });
    it("aceita um candidato que conversou com o canal", async () => {
      row.metadata.ai_test_social_identities = [antigo];
      const response = await PATCH(social([testador, antigo]), context());
      expect(response.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith("fn_configurar_pre_go_live_canal", expect.objectContaining({ p_identidades: [testador, antigo] }));
    });
    it("remover é sempre permitido, até num canal que não é de rede social", async () => {
      row.provider = DEFAULT_CHANNEL_PROVIDER;
      const response = await PATCH(social([]), context());
      expect(response.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith("fn_configurar_pre_go_live_canal", expect.objectContaining({ p_identidades: [] }));
    });
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
