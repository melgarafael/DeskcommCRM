/**
 * A CASCA DO `/app` NÃO PÕE EM FILA LEITURAS QUE NÃO DEPENDEM UMA DA OUTRA.
 *
 * Toda tela de `/app` passa por `loadAuthUser`, pela política de MFA e pelo
 * `AppLayout` antes de desenhar qualquer coisa, e cada leitura ao Supabase ali
 * custa uma ida e volta pela rede (medido numa VPS em Frankfurt com o Supabase na
 * Irlanda: 100–250 ms cada). Três delas esperavam a anterior sem precisar do
 * resultado dela:
 *
 *  - `fn_support_context` esperava `platform_admins` + `user_organizations`;
 *  - na política de MFA, `organizations` esperava `platform_admins`;
 *  - no layout, o tema de extensão esperava o lote inteiro das cinco consultas.
 *
 * Cada caso aqui SEGURA a primeira leitura (uma promessa que só resolve quando o
 * teste manda) e pergunta se a segunda já foi disparada enquanto a primeira
 * espera. Em fila, ela não foi — e o caso fica vermelho. A medida é de
 * comportamento, não de texto-fonte: sobrevive a qualquer reescrita que mantenha
 * as leituras concorrentes.
 */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect inesperado para ${destino}`);
  },
}));
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: vi.fn(async () => []) }));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: async () => [] }));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Uma promessa que só resolve quando o teste chama `soltar`. */
function portao() {
  let soltar!: () => void;
  const aberto = new Promise<void>((r) => {
    soltar = r;
  });
  return { aberto, soltar };
}

/** Deixa rodar tudo o que já pode rodar sem que o portão abra. */
async function escoar() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Um cliente PostgREST de mentira: registra cada tabela pedida e devolve uma
 * consulta encadeável. As tabelas em `seguradas` só respondem depois do portão.
 */
function clienteFalso(opcoes: {
  pedidos: string[];
  seguradas: string[];
  aberto: Promise<void>;
  linhas?: Record<string, unknown>;
}) {
  const { pedidos, seguradas, aberto, linhas = {} } = opcoes;
  return {
    from(tabela: string) {
      pedidos.push(tabela);
      const resposta = async (unica: boolean) => {
        if (seguradas.includes(tabela)) await aberto;
        const dado = linhas[tabela];
        return { data: unica ? (dado ?? null) : (dado ?? []), error: null };
      };
      const consulta: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "is", "order", "limit", "in"]) {
        consulta[metodo] = () => consulta;
      }
      consulta.maybeSingle = () => resposta(true);
      consulta.then = (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
        resposta(false).then(ok, falha);
      return consulta;
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("a casca do /app dispara juntas as leituras independentes", () => {
  it("loadAuthUser: o contexto de acompanhamento não espera as permissões", async () => {
    const pedidos: string[] = [];
    const { aberto, soltar } = portao();
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue({
      ...clienteFalso({ pedidos, seguradas: ["platform_admins", "user_organizations"], aberto }),
      rpc,
      auth: {
        getUser: async () => ({ data: { user: { id: USER_ID, user_metadata: {} } }, error: null }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const { loadAuthUser } = await import("@/lib/auth/server");
    const usuario = loadAuthUser();
    await escoar();

    expect(pedidos).toEqual(expect.arrayContaining(["platform_admins", "user_organizations"]));
    expect(rpc, "fn_support_context esperou as permissões em fila").toHaveBeenCalledWith(
      "fn_support_context",
    );

    soltar();
    await expect(usuario).resolves.toMatchObject({ id: USER_ID, support: null });
  });

  it("política de MFA: a leitura da empresa não espera a da plataforma", async () => {
    const pedidos: string[] = [];
    const { aberto, soltar } = portao();
    vi.mocked(createAdminClient).mockReturnValue(
      clienteFalso({ pedidos, seguradas: ["platform_admins"], aberto }) as unknown as ReturnType<
        typeof createAdminClient
      >,
    );

    const { exigenciaDeMfa } = await import("@/lib/auth/server");
    const exigencia = exigenciaDeMfa("admin", true, USER_ID, ORG_ID);
    await escoar();

    expect(pedidos).toContain("platform_admins");
    expect(pedidos, "organizations esperou platform_admins em fila").toContain("organizations");

    soltar();
    await expect(exigencia).resolves.toBeDefined();
  });

  it("AppLayout: o tema de extensão não espera o lote das consultas da organização", async () => {
    const pedidos: string[] = [];
    const { aberto, soltar } = portao();
    vi.mocked(createAdminClient).mockReturnValue(
      clienteFalso({
        pedidos,
        seguradas: ["organizations"],
        aberto,
        linhas: { organizations: { onboarded_at: "2026-01-01", status: "active", settings: null } },
      }) as unknown as ReturnType<typeof createAdminClient>,
    );
    vi.doMock("@/lib/auth/server", () => ({
      loadAuthUser: async () => ({
        id: USER_ID,
        idioma: "pt-BR",
        is_platform_admin: false,
        support: null,
        organizations: [],
      }),
      resolveActiveOrg: async () => ({ orgId: ORG_ID, role: "admin", interface_settings: null }),
      isMfaEnrolled: async () => true,
      exigirProvaDeMfa: async () => {},
      requiresMfa: async () => false,
    }));

    const { default: AppLayout } = await import("@/app/app/layout");
    const arvore = AppLayout({ children: null });
    await escoar();

    expect(pedidos).toContain("organizations");
    expect(pedidos, "o tema de extensão esperou o lote em fila").toContain(
      "organization_extensions",
    );

    soltar();
    await expect(arvore as Promise<ReactElement>).resolves.toBeTruthy();
    vi.doUnmock("@/lib/auth/server");
  });
});
