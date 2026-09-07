import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auth FALHA ALTO, não baixo.
 *
 * O defeito que este arquivo trava: `loadAuthUser` descartava o erro das queries de
 * `platform_admins` e `user_organizations`. Query falhando devolvia `null`, `null`
 * virava `[]`, e `[]` significa "usuário sem organização".
 *
 * Resultado medido em 2026-07-30: com o PostgREST fora do ar (`name resolution
 * failed`) depois de um restart do Docker, TODOS os cards de admin sumiram do hub de
 * configurações. Custou seis diagnósticos errados — build velho, processo velho,
 * cache estático, filtro de papel — porque a falha se disfarçava de decisão de
 * autorização.
 *
 * Degradar permissão em silêncio é o pior desfecho num caminho de auth: parece
 * autorização e é infraestrutura.
 */

const consultas: { platformAdmins: unknown; memberships: unknown } = {
  platformAdmins: { data: null, error: null },
  memberships: { data: [], error: null },
};

// `get` entrou junto com a cadeia de idioma (usuário → organização): o
// resolvedor pergunta ao cookie qual organização está ativa. O dublê tinha
// `getAll`/`set` e não `get` — menos completo que a API real, e o teste caía
// por falta do dublê, não por defeito.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async () => ({
        data: { user: { id: "u1", email: "a@b.c", user_metadata: {} } },
        error: null,
      }),
    },
    from: (tabela: string) => {
      const alvo = tabela === "platform_admins" ? "platformAdmins" : "memberships";
      const resultado = () => consultas[alvo as keyof typeof consultas];
      const chain = {
        select: () => chain,
        eq: () => chain,
        // ⚠️ `is()` para memberships devolve o RESULTADO, e não a cadeia — o que
        // fazia dele o terminal obrigatório. A consulta de memberships passou a
        // ordenar (a lista decide qual organização fica ativa sem cookie, e sem
        // `ORDER BY` "a primeira" é o que o Postgres devolver), então o terminal
        // agora pode vir depois de `.order()`. O dublê precisa aceitar as duas
        // formas — e é thenable, então `await` no fim resolve igual.
        is: () =>
          alvo === "platformAdmins"
            ? { maybeSingle: async () => resultado() }
            : { ...chain, then: chain.then },
        order: () => ({ ...chain, then: chain.then }),
        maybeSingle: async () => resultado(),
        then: (r: (v: unknown) => unknown) => Promise.resolve(resultado()).then(r),
      };
      return chain;
    },
  }),
}));

const { loadAuthUser } = await import("@/lib/auth/server");

beforeEach(() => {
  consultas.platformAdmins = { data: null, error: null };
  consultas.memberships = { data: [], error: null };
});

describe("loadAuthUser — falha de permissão não vira 'sem organização'", () => {
  it("query de memberships que FALHA estoura, em vez de devolver zero orgs", async () => {
    consultas.memberships = {
      data: null,
      error: { code: "PGRST002", message: "name resolution failed" },
    };
    await expect(loadAuthUser()).rejects.toThrow(/auth_permissions_unavailable/);
  });

  it("query de platform_admins que FALHA estoura", async () => {
    // `data: null` aqui é AMBÍGUO: é o que a RLS devolve para quem não é admin E o
    // que sobra quando a query quebra. Sem checar o erro, um banco instável rebaixa
    // um super-admin em silêncio.
    consultas.platformAdmins = {
      data: null,
      error: { code: "PGRST002", message: "name resolution failed" },
    };
    await expect(loadAuthUser()).rejects.toThrow(/auth_permissions_unavailable/);
  });

  it("a mensagem diz que NÃO foi decisão de autorização", async () => {
    // Quem lê o erro precisa saber, na primeira linha, que não é permissão — senão
    // procura no lugar errado, como aconteceu.
    consultas.memberships = { data: null, error: { code: "X", message: "boom" } };
    await expect(loadAuthUser()).rejects.toThrow(/NÃO foi rebaixada por decisão de autorização/);
  });

  it("usuário que REALMENTE não tem organização segue funcionando, sem erro", async () => {
    // O contraponto: lista vazia SEM erro é estado legítimo (convite pendente,
    // acesso revogado) e não pode virar exceção.
    consultas.memberships = { data: [], error: null };
    const u = await loadAuthUser();
    expect(u?.organizations).toEqual([]);
  });

  it("usuário com organização resolve normalmente", async () => {
    consultas.memberships = {
      data: [{ organization_id: "o1", role: "admin", organizations: { display_name: "Acme" } }],
      error: null,
    };
    const u = await loadAuthUser();
    expect(u?.organizations).toEqual([
      // `locale` é o idioma padrão da organização, que entra na membership para
      // a resolução do idioma da sessão não precisar de uma segunda consulta.
      // Aqui vem `null` porque o dublê não devolve a coluna.
      { organization_id: "o1", organization_name: "Acme", role: "admin", locale: null, interface_settings: { preset: "completa" } },
    ]);
  });
});
