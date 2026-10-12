/**
 * A RECONEXÃO TEM DE PEDIR O ESCOPO QUE A OPÇÃO EXIGE (#2063).
 *
 * `meetings.space.created` só pode entrar no consentimento — é o único lugar
 * onde o Google concede um escopo. Sem ele na ida, nenhuma conexão nova tem o
 * escopo, o gate duplo do executor (`deveCriarEspacoAberto`) nunca abre e a
 * opção da tela é decorativa: foi exatamente o que a medição da triagem achou
 * (`git grep montarUrlDeConsentimento` → o chamador da agenda não passava
 * `escoposOpcionais`).
 *
 * As três posições, e o que cada uma prova:
 *
 *   LIGADA   → o escopo do Meet entra NO MESMO pedido dos escopos obrigatórios;
 *   DESLIGADA → os obrigatórios saem byte a byte como sempre (nada mudou para
 *               quem não ligou, e exigir o escopo novo derrubaria conexão
 *               existente em `scope_missing`);
 *   leitura falha → falha FECHADA: sem escopo, a mesma disciplina de
 *               `decidirEspacoAberto`, nunca uma exceção na tela de conectar.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { ESCOPOS_OBRIGATORIOS, ESCOPO_MEET_ESPACO_ABERTO } from "@/lib/agenda/google/oauth";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }),
}));

/**
 * O que a sessão devolve em `organizations.settings`. `vi.hoisted` porque o
 * factory do `vi.mock` é içado para o topo do arquivo e não pode esperar a
 * inicialização do escopo do módulo.
 */
const estado = vi.hoisted(() => ({
  settings: undefined as unknown,
  erroDeLeitura: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (estado.erroDeLeitura) throw new Error("não consegui ler o settings");
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { settings: estado.settings }, error: null }),
          }),
        }),
      }),
    };
  },
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";

const usuario: AuthUser = {
  id: ANA,
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "agent" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "agent" };

const CONFIGURADO = {
  GOOGLE_CALENDAR_CLIENT_ID: "123.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "GOCSPX-segredo",
  NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
  INTERNAL_SECRET: "um-segredo-de-instalacao-bem-comprido",
};

async function escoposDoPedido(): Promise<string[]> {
  vi.resetModules();
  const { GET } = await import("@/app/api/v1/agenda/google/connect/route");
  const res = await GET(
    new NextRequest("https://crm.exemplo/api/v1/agenda/google/connect", {
      headers: { "x-request-id": "req-1" },
    }),
  );
  const destino = new URL(res.headers.get("location") ?? "");
  return (destino.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  for (const [k, v] of Object.entries(CONFIGURADO)) process.env[k] = v;
  estado.settings = undefined;
  estado.erroDeLeitura = false;
});

describe("GET /agenda/google/connect — escopo opcional do Meet (#2063)", () => {
  it("com a opção LIGADA, o consentimento pede meetings.space.created", async () => {
    estado.settings = { google_meet_acesso_aberto: true };
    const escopos = await escoposDoPedido();
    expect(escopos).toContain(ESCOPO_MEET_ESPACO_ABERTO);
    // Junto, e não no lugar: o pedido continua sendo o de sempre + este.
    for (const obrigatorio of ESCOPOS_OBRIGATORIOS) expect(escopos).toContain(obrigatorio);
  });

  it("com a opção DESLIGADA, o pedido é exatamente o de sempre", async () => {
    estado.settings = {};
    const semChave = await escoposDoPedido();
    expect(semChave).toEqual([...ESCOPOS_OBRIGATORIOS]);

    estado.settings = { google_meet_acesso_aberto: false };
    const desligada = await escoposDoPedido();
    expect(desligada).toEqual([...ESCOPOS_OBRIGATORIOS]);
  });

  it("falha ao ler o settings: sem escopo, e sem estourar a tela de conectar", async () => {
    estado.erroDeLeitura = true;
    await expect(escoposDoPedido()).resolves.toEqual([...ESCOPOS_OBRIGATORIOS]);
  });
});
