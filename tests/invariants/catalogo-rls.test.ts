import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O MAPEAMENTO DO CATÁLOGO NÃO VAZA ENTRE ORGANIZAÇÕES — E SÓ `admin` ESCREVE.
 *
 * ═══ Por que um arquivo próprio ═══
 *
 * `tests/invariants/**` é congelado por `loop/hooks/freeze-invariants.sh`:
 * arquivo NOVO passa, arquivo MODIFICADO exige escape. Este mede a tabela nova
 * `catalog_mappings` (migration 0244) sem tocar em invariante existente.
 *
 * ═══ O que este arquivo prova ═══
 *
 * 1. Controle positivo: quem é da organização lê o próprio mapeamento.
 * 2. Isolamento: zero linhas do vizinho.
 * 3. RBAC: `agent` NÃO escreve (a policy exige `admin`); `admin` escreve.
 * 4. Privilégios: `anon` não lê.
 *
 * A leitura pública do catálogo é decisão do dono (saber que existe um catálogo
 * não é segredo); o que a policy protege é a ESCRITA — quem aponta o agente para
 * uma tabela é `admin`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda como um usuário autenticado (JWT simulado), como em produção. */
function asUser(userId: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${corpo}
  `);
}

function countAs(userId: string, countQuery: string): number {
  const out = asUser(userId, countQuery);
  const ultima = out.split("\n").pop();
  if (ultima === undefined || !/^\d+$/.test(ultima)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(ultima);
}

// UUIDs próprios, para não disputar linhas com os outros invariantes.
const ORG_A = "ca7a1000-0000-4000-8000-00000000000a";
const ORG_B = "ca7a1000-0000-4000-8000-00000000000b";
const AGENT_A = "ca7a1111-0000-4000-8000-00000000000a";
const AGENT_B = "ca7a1111-0000-4000-8000-00000000000b";
const ADMIN_A = "ca7a2222-0000-4000-8000-00000000000a";

const TABELA = "public.catalog_mappings";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'catalogo-a@invariant.test'),
      ('${AGENT_B}', 'catalogo-b@invariant.test'),
      ('${ADMIN_A}', 'catalogo-admin-a@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'catalogo-a', 'Catalogo A', 'Catalogo A'),
      ('${ORG_B}', 'catalogo-b', 'Catalogo B', 'Catalogo B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${AGENT_B}', '${ORG_B}', 'agent', now()),
      ('${ADMIN_A}', '${ORG_A}', 'admin', now())
      on conflict do nothing;

    -- Cada org precisa de uma conexão (FK do mapeamento).
    insert into public.external_db_connections
      (organization_id, label, host, port, database_name, username,
       password_encrypted, password_iv, password_tag, ssl_mode)
    select v.org, 'Conexao do catalogo', 'db.invariante.test', 5432, 'crm_outro', 'leitor',
           '\\xdeadbeef'::bytea,
           '\\x00112233445566778899aabb'::bytea,
           '\\x00112233445566778899aabbccddeeff'::bytea,
           'require'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (
       select 1 from public.external_db_connections c where c.organization_id = v.org
     );

    -- Um mapeamento por organização, apontando para a conexão da própria org.
    insert into public.catalog_mappings
      (organization_id, connection_id, schema_name, table_name, col_nome, col_preco, col_imagem)
    select v.org, c.id, 'public', 'motos', 'nome', 'preco', 'imagem_url'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
      join public.external_db_connections c on c.organization_id = v.org
     where not exists (
       select 1 from public.catalog_mappings m where m.organization_id = v.org
     );
  `);
});

describe("catalog_mappings — isolamento entre organizações", () => {
  it("o agent da org A lê o PRÓPRIO mapeamento (controle positivo)", () => {
    const proprios = countAs(AGENT_A, `select count(*) from ${TABELA} where organization_id = '${ORG_A}';`);
    expect(proprios).toBeGreaterThan(0);
  });

  it("o agent da org A lê ZERO linhas da org B", () => {
    const vizinha = countAs(AGENT_A, `select count(*) from ${TABELA} where organization_id = '${ORG_B}';`);
    expect(vizinha).toBe(0);
  });

  it("o agent da org B lê ZERO linhas da org A", () => {
    const vizinha = countAs(AGENT_B, `select count(*) from ${TABELA} where organization_id = '${ORG_A}';`);
    expect(vizinha).toBe(0);
  });
});

describe("catalog_mappings — RBAC de escrita", () => {
  it("`agent` NÃO consegue alterar o mapeamento (a policy exige admin)", () => {
    expect(() =>
      asUser(
        AGENT_A,
        `update ${TABELA} set table_name = 'outra' where organization_id = '${ORG_A}';`,
      ),
    ).toThrow();
  });

  it("`admin` consegue alterar o mapeamento da própria org", () => {
    const afetadas = asUser(
      ADMIN_A,
      `with up as (
         update ${TABELA} set table_name = table_name where organization_id = '${ORG_A}' returning 1
       ) select count(*) from up;`,
    );
    const ultima = afetadas.split("\n").pop();
    expect(Number(ultima)).toBeGreaterThan(0);
  });
});

describe("catalog_mappings — privilégios", () => {
  it("`anon` NÃO tem SELECT na tabela (revoke explícito)", () => {
    expect(sql(`select has_table_privilege('anon', '${TABELA}', 'SELECT');`)).toBe("f");
  });
});
