/**
 * QUEM ACEITA CONVITE NÃO CAI NO ONBOARDING DA EMPRESA (#5127).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `app/app/layout.tsx` mandava para `/onboarding` TODA pessoa de uma organização
 * com `onboarded_at` vazio. Numa instalação nova, o dono convida alguém como
 * `agent` antes de terminar a configuração; a pessoa aceita o convite e cai no
 * `/onboarding/welcome` — o assistente que configura a empresa, que não é dela.
 *
 * ─── O que este arquivo mede, e como ────────────────────────────────────────
 *
 * Ele EXECUTA o Server Component `AppLayout`, não lê o texto-fonte. A regra é a
 * que o produto precisa: quem entrou por convite vai para o CRM, inclusive um
 * `admin` convidado — o wizard é de quem configura a empresa, e uma empresa que
 * já tem um admin que não entrou por convite não precisa do convidado ali.
 *
 * Os dois lados estão presos de propósito, para que "apagar o redirect" não
 * passe: o dono sem convite continua indo ao wizard, e o dono de um tenant
 * aberto pelo painel de plataforma (convidado como `admin` por quem o abriu, e
 * o vínculo provisório desse convidador sai no aceite) também. O que distingue
 * os dois é o CONVIDADOR: se ele continua na empresa, o convidado é hóspede e
 * vai para o CRM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  linha: null as unknown,
  erro: null as unknown,
  vinculo: null as unknown,
  /** O convidador do vínculo ainda é membro ativo da empresa? */
  convidadorAtivo: true as boolean,
  usuario: "convidado-1" as string,
  papel: "agent" as string,
}));

const adminClient = {
  from: (tabela: string) => {
    if (tabela === "user_organizations") {
      return {
        select: (colunas: string) => {
          if (colunas === "invited_by") {
            return {
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: estado.vinculo, error: null }) }),
              }),
            };
          }
          // A segunda leitura: o vínculo do CONVIDADOR continua ativo?
          return {
            eq: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => ({
                    data: estado.convidadorAtivo ? { user_id: "dono-1" } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        },
      };
    }
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: estado.linha, error: estado.erro }) }),
      }),
    };
  },
};

vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: estado.usuario,
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: estado.papel, interface_settings: null }),
  isMfaEnrolled: async () => true,
  exigirProvaDeMfa: async () => {},
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
// `getAll` não é enfeite: o cliente da sessão (`lib/supabase/server`) lê os
// cookies por ele. Um dublê só com `get` derruba a casca — e o teste passaria
// com o erro registrado como unhandled, que é ainda pior (#3088).
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

beforeEach(() => {
  estado.erro = null;
  estado.usuario = "convidado-1";
  estado.papel = "agent";
  estado.convidadorAtivo = true;
  estado.linha = {
    onboarded_at: null,
    status: "active",
    settings: null,
    timezone: "America/Sao_Paulo",
  };
  estado.vinculo = { invited_by: "dono-1" };
});

describe("layout de /app × empresa ainda em configuração", () => {
  it("quem aceitou convite como atendente entra no CRM, sem passar pelo onboarding", async () => {
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });

  it("dono que se cadastrou (vínculo sem convite) continua sendo levado ao wizard", async () => {
    estado.vinculo = { invited_by: null };
    estado.papel = "admin";
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow("redirect:/onboarding");
  });

  it("admin convidado por alguém que continua na empresa entra no CRM", async () => {
    estado.papel = "admin";
    estado.convidadorAtivo = true;
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });

  it("dono convidado como admin de tenant aberto pelo painel (convidador já não é membro) continua indo ao wizard", async () => {
    estado.papel = "admin";
    estado.convidadorAtivo = false;
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow("redirect:/onboarding");
  });

  it("gerente que entrou por convite também não cai no onboarding", async () => {
    estado.papel = "manager";
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });

  it("convidado que não administra não cai no onboarding nem se o convidador saiu", async () => {
    estado.papel = "agent";
    estado.convidadorAtivo = false;
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).resolves.toBeTruthy();
  });

  it("vínculo antigo/criado à mão, sem convite legível, mantém o comportamento anterior", async () => {
    estado.vinculo = null;
    estado.papel = "manager";
    const { default: AppLayout } = await import("@/app/app/layout");
    await expect(AppLayout({ children: null })).rejects.toThrow("redirect:/onboarding");
  });
});
