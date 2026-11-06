import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  servico: true,
  // Vínculos de `user_organizations`, inclusive o revogado: a regra não filtra `revoked_at`.
  vinculos: [] as Array<{ organization_id: string; user_id: string; revoked_at: string | null }>,
  erroVinculos: null as { message: string } | null,
  nomes: {} as Record<string, string>,
  consultas: [] as Array<{ tabela: string; eq: Record<string, unknown>; in: unknown[] }>,
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => m.servico }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.createAdminClient }));

import { comNomeDoAtendente } from "./com-nome-do-atendente";
import { nomesDosAtendentes } from "./nome-do-atendente";

const ORG = "org-a";
const OUTRA_ORG = "org-b";

type Vinculo = { organization_id: string; user_id: string; revoked_at: string | null };

/**
 * Builder fiel ao supabase-js no que importa aqui: devolve a LINHA inteira
 * (com `revoked_at`) projetada pelas colunas do `select`, e aplica `.eq`, `.in`
 * e `.is` como filtros reais. Assim um filtro de revogação acrescentado ao
 * código — por `.is`, ou por `select` + filtro em memória — tira a Bia de fato,
 * em vez de lançar por método ausente e reprovar pelo motivo errado.
 */
function clienteDeServico() {
  return {
    from(tabela: string) {
      const consulta = { tabela, eq: {} as Record<string, unknown>, in: [] as unknown[] };
      m.consultas.push(consulta);
      let colunas: Array<keyof Vinculo> = ["organization_id", "user_id", "revoked_at"];
      const filtros: Array<(v: Vinculo) => boolean> = [];
      const q = {
        select: (cols: string) => {
          colunas = cols.split(",").map((c) => c.trim() as keyof Vinculo);
          return q;
        },
        eq: (col: keyof Vinculo, val: unknown) => {
          consulta.eq[col] = val;
          filtros.push((v) => v[col] === val);
          return q;
        },
        in: (col: keyof Vinculo, vs: unknown[]) => {
          consulta.in = vs;
          filtros.push((v) => vs.includes(v[col]));
          return q;
        },
        is: (col: keyof Vinculo, val: null) => {
          filtros.push((v) => v[col] === val);
          return q;
        },
        then<R>(resolve: (r: { data: unknown; error: unknown }) => R) {
          if (m.erroVinculos) return Promise.resolve({ data: null, error: m.erroVinculos }).then(resolve);
          const data = m.vinculos
            .filter((v) => filtros.every((f) => f(v)))
            .map((v) => Object.fromEntries(colunas.map((c) => [c, v[c]])));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return q;
    },
    auth: {
      admin: {
        getUserById: vi.fn(async (id: string) => ({
          data: { user: { user_metadata: { full_name: m.nomes[id] } } },
          error: null,
        })),
      },
    },
  };
}

beforeEach(() => {
  m.servico = true;
  m.erroVinculos = null;
  m.consultas = [];
  m.nomes = { "u-ana": "Ana", "u-bia": "Bia", "u-caio": "Caio" };
  m.vinculos = [
    { organization_id: ORG, user_id: "u-ana", revoked_at: null },
    { organization_id: ORG, user_id: "u-bia", revoked_at: "2026-10-01T00:00:00Z" },
    { organization_id: OUTRA_ORG, user_id: "u-caio", revoked_at: null },
  ];
  m.createAdminClient.mockReset();
  m.createAdminClient.mockImplementation(clienteDeServico);
});

describe("nomesDosAtendentes — só membros da organização ganham nome", () => {
  it("membro e ex-membro ganham nome; id de outra organização não", async () => {
    const nomes = await nomesDosAtendentes(ORG, ["u-ana", "u-bia", "u-caio"]);
    expect(nomes.get("u-ana")).toBe("Ana");
    expect(nomes.get("u-bia")).toBe("Bia");
    expect(nomes.get("u-caio") ?? null).toBeNull();
  });

  it("o id de fora nem chega a ser consultado no cadastro de usuários", async () => {
    const admin = clienteDeServico();
    m.createAdminClient.mockReturnValue(admin);
    await nomesDosAtendentes(ORG, ["u-ana", "u-caio"]);
    expect(admin.auth.admin.getUserById).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.getUserById).toHaveBeenCalledWith("u-ana");
  });

  it("uma consulta de vínculo por chamada, filtrada pela organização, com os ids distintos", async () => {
    await nomesDosAtendentes(ORG, ["u-ana", "u-ana", null, "u-caio", undefined]);
    expect(m.consultas).toEqual([
      { tabela: "user_organizations", eq: { organization_id: ORG }, in: ["u-ana", "u-caio"] },
    ]);
  });

  it("vínculo que não pôde ser lido: ninguém ganha nome e nada lança", async () => {
    m.erroVinculos = { message: "fora do ar" };
    const nomes = await nomesDosAtendentes(ORG, ["u-ana"]);
    expect(nomes.get("u-ana") ?? null).toBeNull();
  });

  it("sem service role não abre o client de serviço", async () => {
    m.servico = false;
    const nomes = await nomesDosAtendentes(ORG, ["u-ana"]);
    expect(nomes.size).toBe(0);
    expect(m.createAdminClient).not.toHaveBeenCalled();
  });
});

describe("comNomeDoAtendente — a coluna da conversa segue a mesma regra", () => {
  it("o nome gravado na linha só sai para membro e ex-membro da organização", async () => {
    const conversas = await comNomeDoAtendente(ORG, [
      { assigned_to_user_id: "u-ana", assigned_to_user_name: "Ana" },
      { assigned_to_user_id: "u-bia", assigned_to_user_name: "Bia" },
      { assigned_to_user_id: "u-caio", assigned_to_user_name: "Caio" },
      { assigned_to_user_id: null, assigned_to_user_name: "Caio" },
    ]);
    expect(conversas.map((c) => c.assigned_to_user_name)).toEqual(["Ana", "Bia", null, null]);
  });

  it("vínculo que não pôde ser lido: nenhuma linha sai com nome", async () => {
    m.erroVinculos = { message: "fora do ar" };
    const conversas = await comNomeDoAtendente(ORG, [{ assigned_to_user_id: "u-ana", assigned_to_user_name: "Ana" }]);
    expect(conversas.map((c) => c.assigned_to_user_name)).toEqual([null]);
  });
});
