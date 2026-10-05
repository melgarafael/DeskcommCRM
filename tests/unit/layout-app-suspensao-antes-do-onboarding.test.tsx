import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ linha: null as unknown, erro: null as unknown }));
const adminClient = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: estado.linha, error: estado.erro }) }) }),
  }),
};
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", idioma: "pt-BR", is_platform_admin: false, support: null, organizations: [] }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "admin", interface_settings: null }),
  isMfaEnrolled: async () => true,
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm", logoUrl: null, cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

beforeEach(() => {
  estado.linha = { onboarded_at: "2026-01-01", status: "active", settings: null };
  estado.erro = null;
});

describe("layout de /app × org parada", () => {
  it("org suspensa que nunca terminou o onboarding vai para /account-suspended, não /onboarding", async () => {
    estado.linha = { onboarded_at: null, status: "suspended", settings: null };
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow("redirect:/account-suspended");
  });

  it("leitura de organizations que falha LANÇA em vez de renderizar a casca", async () => {
    estado.linha = null;
    estado.erro = { message: "connection reset" };
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow(/organizacao_ilegivel/);
  });

  it("CONTROLE: org ativa e onboardada renderiza", async () => {
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });
});
