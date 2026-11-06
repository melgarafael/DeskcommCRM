import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (d: string) => { throw new Error(`REDIRECT:${d}`); },
}));
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: vi.fn(async () => []) }));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: async () => [] }));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({ name: "x", logoUrl: null, cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" } }),
}));

const U = "11111111-1111-4111-8111-111111111111";
const O = "22222222-2222-4222-8222-222222222222";

function cliente(pedidos: string[], linhas: Record<string, { data: unknown; error: unknown }>, explode: string[] = []) {
  return {
    from(t: string) {
      pedidos.push(t);
      if (explode.includes(t)) throw new Error(`explodiu ${t}`);
      const r = async () => linhas[t] ?? { data: null, error: null };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit", "in"]) q[m] = () => q;
      q.maybeSingle = r;
      q.then = (ok: (v: unknown) => unknown, f: (e: unknown) => unknown) => r().then(ok, f);
      return q;
    },
  };
}

const rejeicoes: unknown[] = [];
const anotaRejeicao = (e: unknown) => { rejeicoes.push(e); };
process.on("unhandledRejection", anotaRejeicao);
afterAll(() => { process.off("unhandledRejection", anotaRejeicao); });
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); rejeicoes.length = 0; });

describe("casca do /app: leituras paralelas não mudam a ordem dos erros nem deixam promessa órfã", () => {
  it("loadAuthUser: erro de permissão E de suporte juntos -> o de permissão vence", async () => {
    const pedidos: string[] = [];
    vi.mocked(createClient).mockResolvedValue({
      ...cliente(pedidos, { user_organizations: { data: null, error: { code: "X", message: "boom" } } }),
      rpc: async () => ({ data: null, error: { message: "rpc caiu" } }),
      auth: { getUser: async () => ({ data: { user: { id: U, user_metadata: {} } }, error: null }) },
    } as never);
    const { loadAuthUser } = await import("@/lib/auth/server");
    await expect(loadAuthUser()).rejects.toThrow(/auth_permissions_unavailable/);
    await new Promise((r) => setTimeout(r, 10));
    expect(rejeicoes).toEqual([]);
  });

  it("loadAuthUser: so o suporte falha -> lança a mensagem do suporte", async () => {
    vi.mocked(createClient).mockResolvedValue({
      ...cliente([], { user_organizations: { data: [], error: null } }),
      rpc: async () => ({ data: null, error: { message: "rpc caiu" } }),
      auth: { getUser: async () => ({ data: { user: { id: U, user_metadata: {} } }, error: null }) },
    } as never);
    const { loadAuthUser } = await import("@/lib/auth/server");
    await expect(loadAuthUser()).rejects.toThrow(/acompanhamento administrativo/);
  });

  it("loadAuthUser: sem sessao -> null e nenhuma leitura nem RPC", async () => {
    const pedidos: string[] = [];
    const rpc = vi.fn();
    vi.mocked(createClient).mockResolvedValue({
      ...cliente(pedidos, {}), rpc,
      auth: { getUser: async () => ({ data: { user: null }, error: { name: "AuthSessionMissingError" } }) },
    } as never);
    const { loadAuthUser } = await import("@/lib/auth/server");
    await expect(loadAuthUser()).resolves.toBeNull();
    expect(pedidos).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("exigenciaDeMfa: nao-admin sem org nao le nada; admin com org le as duas", async () => {
    const p1: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(cliente(p1, {}) as never);
    const { exigenciaDeMfa } = await import("@/lib/auth/server");
    await exigenciaDeMfa("agent", false, U, undefined);
    expect(p1).toEqual([]);
    const p2: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(cliente(p2, {
      platform_admins: { data: { mfa_required: true }, error: null },
    }) as never);
    const r = await exigenciaDeMfa("agent", true, U, O);
    expect(p2.sort()).toEqual(["organizations", "platform_admins"]);
    expect(r.bloqueia).toBe(true);
  });

  for (const modo of ["explode", "erro"] as const) {
    it(`AppLayout: org suspensa redireciona mesmo com o tema ${modo}; sem rejeição órfã`, async () => {
      const pedidos: string[] = [];
      vi.mocked(createAdminClient).mockReturnValue(cliente(pedidos, {
        organizations: { data: { onboarded_at: "2026-01-01", status: "suspended", settings: null }, error: null },
        organization_extensions: { data: null, error: { message: "sem tabela" } },
      }, modo === "explode" ? ["organization_extensions"] : []) as never);
      vi.doMock("@/lib/auth/server", () => ({
        loadAuthUser: async () => ({ id: U, idioma: "pt-BR", is_platform_admin: false, support: null, organizations: [] }),
        resolveActiveOrg: async () => ({ orgId: O, role: "admin", interface_settings: null }),
        isMfaEnrolled: async () => true,
        exigirProvaDeMfa: async () => {},
        requiresMfa: async () => false,
      }));
      const { default: AppLayout } = await import("@/app/app/layout");
      await expect(AppLayout({ children: null }) as Promise<unknown>).rejects.toThrow("REDIRECT:/account-suspended");
      await new Promise((r) => setTimeout(r, 10));
      expect(rejeicoes).toEqual([]);
      vi.doUnmock("@/lib/auth/server");
    });
  }
});
