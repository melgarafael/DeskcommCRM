import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  servico: true,
  // Vínculos de `user_organizations`, inclusive o revogado: a regra não filtra `revoked_at`.
  vinculos: [] as Array<{ organization_id: string; user_id: string; revoked_at: string | null }>,
  erroVinculos: null as { message: string } | null,
  // `full_name` de `auth.users.raw_user_meta_data` (e o e-mail, que a função devolve).
  nomes: {} as Record<string, string | null | undefined>,
  emails: {} as Record<string, string>,
  consultas: [] as Array<{ tabela: string; eq: Record<string, unknown>; in: unknown[] }>,
  // A chamada à função do banco: uma por leitura, com a org e os ids distintos.
  chamadasRpc: [] as Array<{ funcao: string; org: string; ids: string[] }>,
  erroRpc: null as { message: string } | null,
  // O GET do endpoint admin do GoTrue — tem de ficar em ZERO depois desta fatia.
  getUserById: vi.fn(),
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
 * Builder fiel ao supabase-js no que importa aqui.
 *
 * `from` devolve a LINHA inteira (com `revoked_at`) projetada pelas colunas do
 * `select` e aplica `.eq`, `.in` e `.is` como filtros reais — assim um filtro de
 * revogação acrescentado ao código tira a Bia de fato, em vez de lançar por
 * método ausente e reprovar pelo motivo errado.
 *
 * `rpc("fn_nomes_dos_membros")` reproduz a REGRA DA FUNÇÃO (migration 9314):
 * só id com vínculo com a org pedida (`revoked_at` não filtra), o nome de
 * `raw_user_meta_data ->> 'full_name'` e o e-mail; id repetido na lista não
 * duplica a linha, e id sem vínculo não ganha linha nenhuma.
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
    rpc(funcao: string, args: { p_org: string; p_ids: string[] }) {
      m.chamadasRpc.push({ funcao, org: args.p_org, ids: args.p_ids });
      if (m.erroRpc) return Promise.resolve({ data: null, error: m.erroRpc });
      const ids = [...new Set(args.p_ids)];
      const data = ids
        .filter((id) => m.vinculos.some((v) => v.organization_id === args.p_org && v.user_id === id))
        .map((id) => ({ user_id: id, full_name: m.nomes[id] ?? null, email: m.emails[id] ?? null }));
      return Promise.resolve({ data, error: null });
    },
    auth: {
      admin: {
        getUserById: m.getUserById,
      },
    },
  };
}

beforeEach(() => {
  m.servico = true;
  m.erroVinculos = null;
  m.erroRpc = null;
  m.consultas = [];
  m.chamadasRpc = [];
  m.nomes = { "u-ana": "Ana", "u-bia": "Bia", "u-caio": "Caio" };
  m.emails = { "u-ana": "ana@acme.test", "u-bia": "bia@acme.test", "u-caio": "caio@outra.test" };
  m.vinculos = [
    { organization_id: ORG, user_id: "u-ana", revoked_at: null },
    { organization_id: ORG, user_id: "u-bia", revoked_at: "2026-10-01T00:00:00Z" },
    { organization_id: OUTRA_ORG, user_id: "u-caio", revoked_at: null },
  ];
  m.getUserById.mockReset();
  m.getUserById.mockImplementation(async (id: string) => ({
    data: { user: { user_metadata: { full_name: m.nomes[id] } } },
    error: null,
  }));
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

  it("⭐ ZERO chamadas HTTP ao GoTrue: o nome sai de UMA consulta ao banco", async () => {
    await nomesDosAtendentes(ORG, ["u-ana", "u-bia", "u-caio"]);

    expect(m.getUserById).not.toHaveBeenCalled();
    expect(m.chamadasRpc).toEqual([
      { funcao: "fn_nomes_dos_membros", org: ORG, ids: ["u-ana", "u-bia", "u-caio"] },
    ]);
    // Nenhuma leitura avulsa de vínculo: a função já responde a regra inteira.
    expect(m.consultas).toEqual([]);
  });

  it("o mapa é o de antes: quem não tem `full_name` fica sem nome, e o de fora também", async () => {
    const nomes = await nomesDosAtendentes(ORG, ["u-ana", "u-bia", "u-caio", "u-sem-nome"]);
    expect([...nomes]).toEqual([
      ["u-ana", "Ana"],
      ["u-bia", "Bia"],
      ["u-caio", null],
      ["u-sem-nome", null],
    ]);
    expect(m.getUserById).not.toHaveBeenCalled();
  });

  it("id repetido na lista não duplica linha nem chamada", async () => {
    const nomes = await nomesDosAtendentes(ORG, ["u-ana", "u-ana", null, "u-caio", undefined]);
    expect(nomes.size).toBe(2);
    expect(m.chamadasRpc).toEqual([{ funcao: "fn_nomes_dos_membros", org: ORG, ids: ["u-ana", "u-caio"] }]);
    expect(m.getUserById).not.toHaveBeenCalled();
  });

  it("leitura que falha: ninguém ganha nome, o mapa mantém as chaves e nada lança", async () => {
    m.erroRpc = { message: "fora do ar" };
    const nomes = await nomesDosAtendentes(ORG, ["u-ana"]);
    expect(nomes.size).toBe(1);
    expect(nomes.get("u-ana") ?? null).toBeNull();
    expect(m.getUserById).not.toHaveBeenCalled();
  });

  it("sem service role não abre o client de serviço", async () => {
    m.servico = false;
    const nomes = await nomesDosAtendentes(ORG, ["u-ana"]);
    expect(nomes.size).toBe(0);
    expect(m.createAdminClient).not.toHaveBeenCalled();
    expect(m.getUserById).not.toHaveBeenCalled();
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
    expect(m.getUserById).not.toHaveBeenCalled();
  });

  it("vínculo que não pôde ser lido: nenhuma linha sai com nome", async () => {
    m.erroVinculos = { message: "fora do ar" };
    const conversas = await comNomeDoAtendente(ORG, [{ assigned_to_user_id: "u-ana", assigned_to_user_name: "Ana" }]);
    expect(conversas.map((c) => c.assigned_to_user_name)).toEqual([null]);
    expect(m.getUserById).not.toHaveBeenCalled();
  });
});
