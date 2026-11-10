/**
 * AS TELAS DA INSTALAÇÃO EM `/app` LEVAM AO CÓDIGO ANTES DE ABRIR (#3200).
 *
 * As ações de Extensões, do Servidor MCP externo e da Atualização do sistema
 * usam a régua ESTRITA (`regraPlatformAdmin` / `requirePlatformAdminEscrita` →
 * `mfaEmDividaEstrita`): só o código provado nesta
 * sessão vale. A casca de `/app` usa a branda, que aceita o dispositivo
 * confiável. Sem uma checagem na própria página, o dono da instalação (admin da
 * própria empresa) que entrou pelo dispositivo confiável abria a tela e recebia
 * `mfa_required` em toda ação — e entrar de novo não pedia o código.
 *
 * Executa as páginas com o `lib/auth/server` REAL (só a identidade é fixada);
 * o que varia é o que o Supabase responde sobre fatores, sessão e confiança.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

const U = "11111111-1111-4111-8111-111111111111";
const O = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  caminho: "/app/extensions",
  plataforma: true,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/server")>();
  const user = () => ({
    id: U,
    idioma: "pt-BR",
    is_platform_admin: h.plataforma,
    support: null,
    organizations: [],
  });
  return {
    ...real,
    loadAuthUser: async () => user(),
    requireAuth: async () => user(),
    resolveActiveOrg: async () => ({ orgId: O, role: "admin", interface_settings: null }),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => {
    const { cabecalhosQueOProxyEntrega } = await import("./helpers/cabecalhos-do-proxy");
    return cabecalhosQueOProxyEntrega(`https://crm.exemplo${h.caminho}`);
  },
}));
vi.mock("@supabase/ssr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/ssr")>()),
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: U } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (d: string) => {
    throw Object.assign(new Error(`REDIRECT:${d}`), { digest: `NEXT_REDIRECT;replace;${d};307;` });
  },
}));
vi.mock("@/components/extensions/ExtensionsManager", () => ({ ExtensionsManager: () => null }));
vi.mock("@/app/app/settings/atualizacao/_components/UpdatePanel", () => ({ UpdatePanel: () => null }));

/**
 * A sessão do dono com fator cadastrado. `aal1` + `confiada` = entrou pelo
 * dispositivo confiável: `fn_session_mfa_proven` diz que sim, o token diz `aal1`.
 */
function sessao(nivel: "aal1" | "aal2", confiada = true) {
  vi.mocked(createClient).mockResolvedValue({
    rpc: async () => ({ data: confiada, error: null }),
    auth: {
      getUser: async () => ({
        data: { user: { id: U, factors: [{ factor_type: "totp", status: "verified" }] } },
        error: null,
      }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: nivel }, error: null }) },
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

async function extensoes() {
  h.caminho = "/app/extensions";
  const { default: Pagina } = await import("@/app/app/extensions/page");
  return Pagina();
}

async function servidorMcp() {
  h.caminho = "/app/settings/servidor-mcp-externo";
  const { default: Pagina } = await import("@/app/app/settings/servidor-mcp-externo/page");
  return Pagina();
}

async function atualizacao() {
  h.caminho = "/app/settings/atualizacao";
  const { default: Pagina } = await import("@/app/app/settings/atualizacao/page");
  return Pagina();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.plataforma = true;
});

describe("dono da instalação que entrou pelo dispositivo confiável", () => {
  it("Extensões leva ao código, de volta para a própria tela", async () => {
    sessao("aal1");
    await expect(extensoes()).rejects.toThrow("REDIRECT:/login/mfa?next=%2Fapp%2Fextensions");
  });

  it("Servidor MCP externo leva ao código, de volta para a própria tela", async () => {
    sessao("aal1");
    await expect(servidorMcp()).rejects.toThrow(
      "REDIRECT:/login/mfa?next=%2Fapp%2Fsettings%2Fservidor-mcp-externo",
    );
  });

  it("Atualização do sistema leva ao código, de volta para a própria tela", async () => {
    sessao("aal1");
    await expect(atualizacao()).rejects.toThrow(
      "REDIRECT:/login/mfa?next=%2Fapp%2Fsettings%2Fatualizacao",
    );
  });
});

describe("controles: quem não deve ir ao código abre a tela", () => {
  it("o dono com o código provado nesta sessão (aal2)", async () => {
    sessao("aal2");
    await expect(extensoes()).resolves.toBeTruthy();
    await expect(servidorMcp()).resolves.toBeTruthy();
    await expect(atualizacao()).resolves.toBeTruthy();
  });

  it("quem não é dono da instalação, no dispositivo confiável (as ações dele não usam a régua estrita)", async () => {
    h.plataforma = false;
    sessao("aal1");
    await expect(extensoes()).resolves.toBeTruthy();
    // A Atualização não existe para ele: some (404), em vez de pedir um código.
    await expect(atualizacao()).rejects.toThrow("NOT_FOUND");
  });
});
