import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
// Módulo `setores` ligado (doc 213): o desligado tem arquivo próprio,
// tests/unit/setores-modulo-desligado.test.ts.
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const ATIVO = "22222222-2222-4222-8222-222222222222";
const REVOGADO = "33333333-3333-4333-8333-333333333333";
const REBAIXADO = "55555555-5555-4555-8555-555555555555";
const SETOR = "44444444-4444-4444-8444-444444444444";

type Chamada = { tabela: string; filtros: Array<[string, unknown]> };

/**
 * Client de mentira: `from(tabela)` devolve um encadeável que registra os
 * filtros e resolve com `respostas[tabela]`. Os filtros importam: a filiação
 * ativa é lida por service role, e só o `.eq("organization_id", …)` à mão e o
 * `.is("revoked_at", null)` separam o que conta do que não conta.
 */
function mockClient(respostas: Record<string, unknown[]>, chamadas: Chamada[]) {
  return {
    from: (tabela: string) => {
      const chamada: Chamada = { tabela, filtros: [] };
      chamadas.push(chamada);
      const q: Record<string, unknown> = {
        select: () => q,
        order: () => q,
        eq: (c: string, v: unknown) => (chamada.filtros.push([c, v]), q),
        is: (c: string, v: unknown) => (chamada.filtros.push([c, v]), q),
        then: (resolve: (r: unknown) => void) => resolve({ data: respostas[tabela] ?? [], error: null }),
      };
      return q;
    },
  } as never;
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ATIVO, idioma: "pt-BR" },
    org: { orgId: ORG, role: "viewer" },
  } as never);
});

describe("GET /api/v1/attendants/sectors", () => {
  it("member_count usa a régua da aba Atendimento: revogado e viewer não entram", async () => {
    const chamadas: Chamada[] = [];
    vi.mocked(createClient).mockResolvedValue(
      mockClient({ attendant_sectors: [{ id: SETOR, name: "Suporte", description: null }] }, chamadas),
    );
    vi.mocked(createAdminClient).mockReturnValue(
      mockClient(
        {
          attendant_sector_members: [
            { sector_id: SETOR, user_id: ATIVO },
            { sector_id: SETOR, user_id: REVOGADO },
            { sector_id: SETOR, user_id: REBAIXADO },
          ],
          // A consulta filtra `revoked_at is null`: o revogado não volta daqui.
          // O rebaixado a viewer volta, e é o papel que o tira da conta.
          user_organizations: [
            { user_id: ATIVO, role: "agent" },
            { user_id: REBAIXADO, role: "viewer" },
          ],
        },
        chamadas,
      ),
    );

    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/attendants/sectors"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; member_count: number }> };
    expect(body.data).toEqual([expect.objectContaining({ id: SETOR, member_count: 1 })]);

    const filiacao = chamadas.find((c) => c.tabela === "user_organizations");
    expect(filiacao?.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["revoked_at", null],
      ]),
    );
    for (const c of chamadas) expect(c.filtros).toContainEqual(["organization_id", ORG]);
  });
});
