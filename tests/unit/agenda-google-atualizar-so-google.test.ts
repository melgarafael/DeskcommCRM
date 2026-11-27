/**
 * "ATUALIZAR CALENDÁRIOS" DO GOOGLE SÓ ACEITA CONEXÃO DO GOOGLE (#1754).
 *
 * Com a agenda do Outlook, `calendar_connections` passa a ter linhas de dois
 * provedores. A rota recebe o `connection_id` direto da tela; sem o filtro de
 * provedor, um id do Outlook chegaria a `refreshCatalog`, que decifra o token
 * da conexão e o usa como se fosse do Google. A consulta tem de levar
 * `provider = google_calendar`, e conexão de outro provedor é 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { refreshCatalog } from "@/lib/agenda/google/calendar-executor";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agenda/google/calendar-executor", () => ({ refreshCatalog: vi.fn(async () => undefined) }));

const banco = vi.hoisted(() => ({
  linha: { id: "", provider: "google_calendar" } as { id: string; provider: string },
  filtros: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      expect(tabela).toBe("calendar_connections");
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          banco.filtros.push([coluna, valor]);
          return cadeia;
        },
        maybeSingle: async () => {
          const casa = banco.filtros.every(([coluna, valor]) =>
            coluna === "provider" ? valor === banco.linha.provider : true,
          );
          return { data: casa ? { id: banco.linha.id } : null, error: null };
        },
      };
      return cadeia;
    },
  }),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const CONEXAO = "33333333-3333-4333-8333-333333333333";

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

async function atualizar(): Promise<Response> {
  const { POST } = await import("@/app/api/v1/agenda/google/calendarios/atualizar/route");
  return POST(
    new Request("https://crm.exemplo/api/v1/agenda/google/calendarios/atualizar", {
      method: "POST",
      body: JSON.stringify({ connection_id: CONEXAO }),
    }),
  );
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  vi.mocked(refreshCatalog).mockClear();
  banco.filtros = [];
  banco.linha = { id: CONEXAO, provider: "google_calendar" };
});

describe("POST /agenda/google/calendarios/atualizar — só conexão do Google", () => {
  it("a consulta filtra o provedor do Google", async () => {
    const res = await atualizar();
    expect(res.status).toBe(200);
    expect(banco.filtros).toContainEqual(["provider", "google_calendar"]);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("conexão do Outlook é 404 e não chega ao catálogo do Google", async () => {
    banco.linha = { id: CONEXAO, provider: "microsoft_calendar" };
    const res = await atualizar();
    expect(res.status).toBe(404);
    expect(refreshCatalog).not.toHaveBeenCalled();
  });
});
