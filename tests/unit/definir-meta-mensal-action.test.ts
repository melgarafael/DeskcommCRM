/**
 * A ACTION QUE GRAVA A META MENSAL (#3025, fatia 1) — o que o Postgres não vê.
 *
 * A régua de escrita é `manager+` em TODAS as camadas que o PR declara: a porta
 * (`minRole: "manager"` em lib/navigation/catalogo.ts), a página
 * (`ROLE_RANK.manager`), o link do painel (`canCompare`) e a policy da tabela
 * (`fn_role_at_least(..., 'manager')`). Este teste prende a action à MESMA régua:
 * se ela cobrar outro papel, o gerente vê o formulário, preenche e recebe "Só
 * quem administra a empresa pode definir a meta".
 *
 *   1. gerente e admin gravam; atendente e leitor nem chegam ao banco;
 *   2. a organização vem da SESSÃO, nunca do input;
 *   3. gravar de novo o mesmo mês ATUALIZA (sem duplicar) e audita o alvo anterior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "manager";
let emDivida = false;
let existente: { id: string; alvo: number } | null = null;
const OUTRO = "33333333-3333-4333-8333-333333333333";
/** Quem é membro da ORG: só o que estiver aqui sai da leitura de `user_organizations`. */
let membros = new Set<string>();
/** Membros com vínculo REVOGADO: só somem da leitura se a consulta filtrar `revoked_at is null`. */
let revogados = new Set<string>();
const inseridas: Array<Record<string, unknown>> = [];
const atualizadas: Array<{ valores: Record<string, unknown>; filtros: Array<[string, unknown]> }> = [];
const leiturasPorOrg: unknown[] = [];
const auditadas: Array<Record<string, unknown>> = [];

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: USER,
    is_platform_admin: false,
    platform_admin_scope: null,
    support: null,
  })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Loja", role: papel })),
  mfaEmDivida: vi.fn(async () => emDivida),
}));

function cadeiaDeLeitura() {
  const c = {
    select: () => c,
    eq: (coluna: string, valor: unknown) => {
      if (coluna === "organization_id") leiturasPorOrg.push(valor);
      return c;
    },
    is: () => c,
    maybeSingle: async () => ({ data: existente, error: null }),
  };
  return c;
}

function cadeiaDeMembros() {
  const filtros = new Map<string, unknown>();
  const c = {
    select: () => c,
    eq: (coluna: string, valor: unknown) => {
      filtros.set(coluna, valor);
      return c;
    },
    is: (coluna: string, valor: unknown) => {
      filtros.set(`is:${coluna}`, valor);
      return c;
    },
    maybeSingle: async () => ({
      data:
        filtros.get("organization_id") === ORG &&
        membros.has(String(filtros.get("user_id"))) &&
        !(filtros.get("is:revoked_at") === null && revogados.has(String(filtros.get("user_id"))))
          ? { user_id: filtros.get("user_id") }
          : null,
      error: null,
    }),
  };
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => ({
      ...(tabela === "user_organizations" ? cadeiaDeMembros() : cadeiaDeLeitura()),
      insert: async (linha: Record<string, unknown>) => {
        inseridas.push(linha);
        return { error: null };
      },
      update: (valores: Record<string, unknown>) => {
        const filtros: Array<[string, unknown]> = [];
        atualizadas.push({ valores, filtros });
        const u = {
          eq: (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            return u;
          },
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
        };
        return u;
      },
    }),
  }),
}));

const { definirMetaMensal } = await import("@/app/actions/settings/definirMetaMensal");

beforeEach(() => {
  papel = "manager";
  emDivida = false;
  existente = null;
  membros = new Set([USER]);
  revogados = new Set();
  inseridas.length = 0;
  atualizadas.length = 0;
  leiturasPorOrg.length = 0;
  auditadas.length = 0;
});

describe("definirMetaMensal", () => {
  it.each(["manager", "admin"])("%s grava a meta da empresa", async (p) => {
    papel = p;
    expect(await definirMetaMensal({ periodo: "2026-10", alvo: 40 })).toEqual({ ok: true });
    expect(inseridas).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        periodo: "2026-10-01",
        indicador: "vendas_ganhas",
        pipeline_id: null,
        alvo: 40,
        created_by: USER,
      }),
    ]);
    expect(auditadas).toEqual([
      expect.objectContaining({ action: "crm_meta.created", organizationId: ORG }),
    ]);
  });

  it.each(["agent", "viewer"])("%s → forbidden_role, e nada é gravado nem auditado", async (p) => {
    papel = p;
    expect(await definirMetaMensal({ periodo: "2026-10", alvo: 40 })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
    expect(inseridas).toEqual([]);
    expect(atualizadas).toEqual([]);
    expect(auditadas).toEqual([]);
  });

  it("sessão devendo o código → mfa_required, e nada é lido, gravado nem auditado", async () => {
    emDivida = true;
    expect(await definirMetaMensal({ periodo: "2026-10", alvo: 40 })).toEqual({
      ok: false,
      error: "mfa_required",
    });
    expect(leiturasPorOrg).toEqual([]);
    expect(inseridas).toEqual([]);
    expect(auditadas).toEqual([]);
  });

  it("a organização vem da sessão: um organization_id no input é ignorado", async () => {
    const input = { periodo: "2026-10", alvo: 40, organization_id: "outra" } as unknown as Parameters<
      typeof definirMetaMensal
    >[0];
    expect(await definirMetaMensal(input)).toEqual({ ok: true });
    expect(leiturasPorOrg).toEqual([ORG]);
    expect(inseridas[0]?.organization_id).toBe(ORG);
  });

  it("regravar o mesmo mês ATUALIZA a linha da organização e audita de quanto para quanto", async () => {
    existente = { id: "meta-1", alvo: 40 };
    expect(await definirMetaMensal({ periodo: "2026-10", alvo: 25 })).toEqual({ ok: true });
    expect(inseridas).toEqual([]);
    expect(atualizadas).toHaveLength(1);
    expect(atualizadas[0]?.valores).toEqual(expect.objectContaining({ alvo: 25 }));
    expect(atualizadas[0]?.filtros).toEqual([
      ["id", "meta-1"],
      ["organization_id", ORG],
    ]);
    expect(auditadas).toEqual([
      expect.objectContaining({
        action: "crm_meta.updated",
        resourceId: "meta-1",
        metadata: expect.objectContaining({ alvo: 25, alvo_anterior: 40 }),
      }),
    ]);
  });

  it("meta de vendedor MEMBRO da organização é gravada com o vendedor_id", async () => {
    expect(
      await definirMetaMensal({ periodo: "2026-10", indicador: "valor_vendido", vendedor_id: USER, alvo: 15_000_000 }),
    ).toEqual({ ok: true });
    expect(inseridas).toEqual([expect.objectContaining({ vendedor_id: USER, indicador: "valor_vendido" })]);
  });

  // #4986: a recusa tem código próprio — com `validation_failed` a tela dizia
  // "o mês e o alvo precisam estar preenchidos", com os dois preenchidos.
  it("vendedor que NÃO é membro da organização → vendedor_fora_da_equipe, e nada é gravado nem auditado", async () => {
    const r = await definirMetaMensal({ periodo: "2026-10", indicador: "valor_vendido", vendedor_id: OUTRO, alvo: 15_000_000 });
    expect(r).toEqual(expect.objectContaining({ ok: false, error: "vendedor_fora_da_equipe" }));
    expect(inseridas).toEqual([]);
    expect(atualizadas).toEqual([]);
    expect(auditadas).toEqual([]);
  });

  it("vendedor com vínculo REVOGADO na organização → vendedor_fora_da_equipe, e nada é gravado nem auditado", async () => {
    membros.add(OUTRO);
    revogados.add(OUTRO);
    const r = await definirMetaMensal({ periodo: "2026-10", indicador: "valor_vendido", vendedor_id: OUTRO, alvo: 15_000_000 });
    expect(r).toEqual(expect.objectContaining({ ok: false, error: "vendedor_fora_da_equipe" }));
    expect(inseridas).toEqual([]);
    expect(atualizadas).toEqual([]);
    expect(auditadas).toEqual([]);
  });

  it("mês fora do formato é recusado antes de qualquer leitura", async () => {
    const r = await definirMetaMensal({ periodo: "2026-13", alvo: 40 });
    expect(r).toEqual(expect.objectContaining({ ok: false, error: "validation_failed" }));
    expect(leiturasPorOrg).toEqual([]);
  });
});
