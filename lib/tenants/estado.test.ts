/**
 * A regra "a organização opera?" e a escolha da organização ativa.
 *
 * Mede o que a aplicação decide antes de qualquer consulta — o banco tem a
 * metade dele provada em `tests/invariants/gestao-de-tenants.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { escolherMembroAtivo } from "@/lib/auth/server";
import type { UserOrgMembership } from "@/lib/auth/types";

import { filtroSemParadas, organizacaoOpera } from "./estado";

const vinculo = (id: string, status?: UserOrgMembership["status"]): UserOrgMembership => ({
  organization_id: id,
  organization_name: id,
  role: "admin",
  status,
});

describe("organizacaoOpera", () => {
  it("só `active` opera; suspensa, redigida e arquivada param", () => {
    expect(organizacaoOpera("active")).toBe(true);
    expect(organizacaoOpera("suspended")).toBe(false);
    expect(organizacaoOpera("redacted")).toBe(false);
    expect(organizacaoOpera("archived")).toBe(false);
  });

  it("status não lido conta como ativo (o banco sempre preenche a coluna)", () => {
    expect(organizacaoOpera(undefined)).toBe(true);
    expect(organizacaoOpera(null)).toBe(true);
  });
});

describe("filtroSemParadas", () => {
  it("lista vazia não gera filtro — o PostgREST recusa `in.()`", () => {
    expect(filtroSemParadas([])).toBeNull();
  });
  it("monta o `(a,b)` do `.not(..., 'in', ...)`", () => {
    expect(filtroSemParadas(["a", "b"])).toBe("(a,b)");
  });
});

describe("escolherMembroAtivo", () => {
  it("sem cookie, prefere a primeira organização que OPERA — não para na suspensa por causa da ordem", () => {
    const escolhido = escolherMembroAtivo(
      [vinculo("A", "suspended"), vinculo("B", "active")],
      undefined,
    );
    expect(escolhido?.organization_id).toBe("B");
  });

  it("o cookie manda, mesmo apontando para a suspensa — a pessoa escolheu e precisa ver a suspensão", () => {
    const escolhido = escolherMembroAtivo([vinculo("A", "suspended"), vinculo("B", "active")], "A");
    expect(escolhido?.organization_id).toBe("A");
  });

  it("todas paradas: cai na primeira (o layout mostra a tela de suspensão)", () => {
    const escolhido = escolherMembroAtivo(
      [vinculo("A", "suspended"), vinculo("B", "suspended")],
      undefined,
    );
    expect(escolhido?.organization_id).toBe("A");
  });
});
