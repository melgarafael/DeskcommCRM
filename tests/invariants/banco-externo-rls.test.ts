import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * A CONEXÃO COM O BANCO EXTERNO NÃO VAZA ENTRE ORGANIZAÇÕES — E A SENHA NÃO
 * SAI DA TABELA.
 *
 * ═══ Por que um arquivo próprio ═══
 *
 * `tests/invariants/**` é congelado por `loop/hooks/freeze-invariants.sh`:
 * arquivo NOVO passa, arquivo MODIFICADO exige escape. Acrescentar a linha na
 * lista fixa de `rls-isolation.test.ts` seria modificação; um arquivo novo mede
 * o caso sem tocar no existente.
 *
 * ═══ O que este arquivo prova ═══
 *
 * 1. Controle positivo: quem é da organização lê a própria conexão. Sem isto, o
 *    jeito trivial de ficar verde é quebrar a feature.
 * 2. Isolamento: zero linhas do vizinho, pela TABELA e pela VIEW.
 * 3. A `_safe` view NÃO carrega as três colunas cifradas. É a barreira que
 *    permite a decisão "qualquer membro vê a lista": a lista é metadata, o
 *    segredo nunca atravessa a view.
 * 4. Privilégios: `anon` não lê nem a tabela nem a view; `authenticated` lê a
 *    view. Uma view `security_invoker` sobre tabela sem GRANT para o chamador
 *    devolveria vazio — e vazio é o falso verde clássico.
 *
 * Conectar como `postgres` mediria NADA (`rolbypassrls = t`). Aqui é
 * `set role authenticated` + `request.jwt.claims`, o mesmo caminho da produção.
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

function linhas(query: string): string[] {
  return sql(query)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const ultima = out.split("\n").pop();
  if (ultima === undefined || !/^\d+$/.test(ultima)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(ultima);
}

// UUIDs próprios, para não disputar linhas com os outros invariantes.
const ORG_A = "db0e1e00-0000-4000-8000-00000000000a";
const ORG_B = "db0e1e00-0000-4000-8000-00000000000b";
const AGENT_A = "db0e1e11-0000-4000-8000-00000000000a";
const AGENT_B = "db0e1e11-0000-4000-8000-00000000000b";

const TABELA = "public.external_db_connections";
const VIEW = "public.external_db_connections_safe";
const COLUNAS_CIFRADAS = ["password_encrypted", "password_iv", "password_tag"] as const;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'banco-externo-a@invariant.test'),
      ('${AGENT_B}', 'banco-externo-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'banco-externo-a', 'Banco Externo A', 'Banco A'),
      ('${ORG_B}', 'banco-externo-b', 'Banco Externo B', 'Banco B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${AGENT_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;

    -- bytea sintético. O importante não é decifrar: é provar que a view não
    -- carrega estas colunas. A chave AES-GCM vive no Node, não no banco.
    insert into public.external_db_connections
      (organization_id, label, host, port, database_name, username,
       password_encrypted, password_iv, password_tag, ssl_mode)
    select v.org, 'Postgres do invariante', 'db.invariante.test', 5432, 'crm_outro', 'leitor',
           '\\xdeadbeef'::bytea,
           '\\x00112233445566778899aabb'::bytea,
           '\\x00112233445566778899aabbccddeeff'::bytea,
           'require'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (
       select 1 from public.external_db_connections c where c.organization_id = v.org
     );
  `);
});

describe("banco externo — isolamento entre organizações", () => {
  it("o agent da org A lê a PRÓPRIA conexão (controle positivo)", () => {
    const proprias = countAs(AGENT_A, `select count(*) from ${TABELA} where organization_id = '${ORG_A}';`);
    expect(proprias).toBeGreaterThan(0);
  });

  it("o agent da org A lê ZERO linhas da org B (tabela)", () => {
    const vizinha = countAs(AGENT_A, `select count(*) from ${TABELA} where organization_id = '${ORG_B}';`);
    expect(vizinha).toBe(0);
  });

  it("o agent da org B lê ZERO linhas da org A (tabela)", () => {
    const vizinha = countAs(AGENT_B, `select count(*) from ${TABELA} where organization_id = '${ORG_A}';`);
    expect(vizinha).toBe(0);
  });

  it("o agent da org A lê ZERO linhas da org B pela VIEW `_safe`", () => {
    const vizinha = countAs(AGENT_A, `select count(*) from ${VIEW} where organization_id = '${ORG_B}';`);
    expect(vizinha).toBe(0);
  });

  it("e lê a própria pela VIEW — `security_invoker` não devolve vazio por acidente", () => {
    const proprias = countAs(AGENT_A, `select count(*) from ${VIEW} where organization_id = '${ORG_A}';`);
    expect(proprias).toBeGreaterThan(0);
  });
});

describe("banco externo — a view não carrega o segredo", () => {
  it("nenhuma das três colunas cifradas existe na `_safe` view", () => {
    const presentes = linhas(`
      select column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'external_db_connections_safe'
         and column_name in (${COLUNAS_CIFRADAS.map((c) => `'${c}'`).join(", ")});
    `);
    expect(presentes).toEqual([]);
  });

  it("a view ainda expõe a metadata útil (a lista de conexões não fica vazia)", () => {
    const metadata = linhas(`
      select column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'external_db_connections_safe'
         and column_name in ('host', 'port', 'database_name', 'username');
    `);
    expect(metadata.sort()).toEqual(["database_name", "host", "port", "username"]);
  });
});

describe("banco externo — privilégios", () => {
  it("`anon` NÃO tem SELECT na tabela (revoke explícito)", () => {
    expect(sql(`select has_table_privilege('anon', '${TABELA}', 'SELECT');`)).toBe("f");
  });

  it("`anon` NÃO tem SELECT na view", () => {
    expect(sql(`select has_table_privilege('anon', '${VIEW}', 'SELECT');`)).toBe("f");
  });

  it("`authenticated` tem SELECT na view", () => {
    expect(sql(`select has_table_privilege('authenticated', '${VIEW}', 'SELECT');`)).toBe("t");
  });
});
