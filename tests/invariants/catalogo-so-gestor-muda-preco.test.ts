import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * O PREÇO DE VENDA NÃO SE ALTERA COM PAPEL DE LEITURA.
 *
 * ═══ Por que um arquivo próprio, e não uma linha em rls-isolation.test.ts ═══
 *
 * Aquele molde mede um eixo só: zero linhas do vizinho, mais de zero linhas
 * próprias. `catalog_products` entra lá pelo eixo de leitura — o `agent` PRECISA
 * ler o catálogo para atender. O eixo que aquele molde não sabe medir é o de
 * ESCRITA, e é o motivo desta tabela existir separada de `nuvemshop_products`,
 * cuja policy é `for all` org-flat sem checagem de papel: lá, hoje, um `viewer`
 * altera preço de venda pelo PostgREST com a anon key + o JWT dele.
 *
 * ═══ O caso que decide ═════════════════════════════════════════════════════
 *
 * O `agent` — o papel de quem atende — lê tudo e não muda nada. Se alguém
 * "simplificar" a policy para o padrão org-flat do resto do repo, o caso do
 * agent-que-escreve reprova. Sem ele, o afrouxamento passa verde.
 *
 * A rota HTTP também exige `manager`, e isso NÃO substitui esta prova: a rota
 * não é a única porta. O PostgREST atende direto.
 *
 * Conectar como `postgres` mediria NADA (rolbypassrls = t). Aqui é `set role
 * authenticated` + `request.jwt.claims`, o mesmo caminho da produção.
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
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda como a sessão de um usuário e devolve a última linha (a contagem). */
function comoUsuario(userId: string, script: string): string {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
  return out.split("\n").pop() ?? "";
}

/** Como superusuário: o que ESTÁ na tabela, independente de quem consegue ler. */
function noBanco(script: string): string {
  return sql(`reset role;\n${script}`).split("\n").pop() ?? "";
}

// UUIDs próprios: os arquivos de invariante compartilham a mesma base.
const ORG_A = "dddddddd-0000-4000-8000-00000000000a";
const ORG_B = "dddddddd-0000-4000-8000-00000000000b";
const MANAGER_A = "dddddddd-1111-4000-8000-00000000000a";
const AGENT_A = "dddddddd-1111-4000-8000-00000000000c";
const MANAGER_B = "dddddddd-1111-4000-8000-00000000000b";

const PRECO_ORIGINAL = 549900;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'catalogo-mgr-a@invariant.test'),
      ('${AGENT_A}',   'catalogo-agent-a@invariant.test'),
      ('${MANAGER_B}', 'catalogo-mgr-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'catalogo-inv-a', 'Catalogo Invariant A', 'Catalogo A'),
      ('${ORG_B}', 'catalogo-inv-b', 'Catalogo Invariant B', 'Catalogo B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    insert into public.catalog_products (organization_id, codigo, nome, preco_cents)
    select v.org, 'INV-IP15', 'iPhone 15 128GB (invariante)', ${PRECO_ORIGINAL}
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (
       select 1 from public.catalog_products p
        where p.organization_id = v.org and p.codigo = 'INV-IP15'
     );
  `);
});

describe("catalog_products — quem lê e quem muda preço", () => {
  it("o agent da org A LÊ o catálogo da própria org (é o papel de quem atende)", () => {
    const lidas = comoUsuario(
      AGENT_A,
      `select count(*) from public.catalog_products where organization_id = '${ORG_A}';`,
    );
    expect(Number(lidas)).toBeGreaterThan(0);
  });

  it("o agent da org A lê ZERO produtos da org B", () => {
    const vizinha = comoUsuario(
      AGENT_A,
      `select count(*) from public.catalog_products where organization_id = '${ORG_B}';`,
    );
    expect(vizinha).toBe("0");
  });

  it("o agent NÃO muda o preço — o caso que separa esta tabela da da Nuvemshop", () => {
    // A prova é por CONTAGEM do estado final, não por capturar a mensagem do
    // erro: `raise notice` sai em stderr, e o execFileSync acima lê só stdout.
    // Ou o preço mudou, ou não mudou.
    comoUsuario(
      AGENT_A,
      `do $$ begin
         update public.catalog_products set preco_cents = 1
          where organization_id = '${ORG_A}' and codigo = 'INV-IP15';
       exception when others then null; end $$;
       select 1;`,
    );

    const preco = noBanco(
      `select preco_cents from public.catalog_products
        where organization_id = '${ORG_A}' and codigo = 'INV-IP15';`,
    );
    expect(preco).toBe(String(PRECO_ORIGINAL));
  });

  it("o agent também não CADASTRA produto", () => {
    comoUsuario(
      AGENT_A,
      `do $$ begin
         insert into public.catalog_products (organization_id, codigo, nome, preco_cents)
           values ('${ORG_A}', 'INV-FORJADO', 'Forjado pelo agent', 100);
       exception when others then null; end $$;
       select 1;`,
    );

    const forjados = noBanco(
      `select count(*) from public.catalog_products where codigo = 'INV-FORJADO';`,
    );
    expect(forjados).toBe("0");
  });

  it("o manager da org A MUDA o preço (controle positivo — a policy não é um muro)", () => {
    // Sem este caso, uma policy que negasse escrita a TODO MUNDO passaria nos
    // dois casos acima e a tabela seria inútil pela tela.
    comoUsuario(
      MANAGER_A,
      `update public.catalog_products set preco_cents = ${PRECO_ORIGINAL + 100}
        where organization_id = '${ORG_A}' and codigo = 'INV-IP15';
       select 1;`,
    );

    const preco = noBanco(
      `select preco_cents from public.catalog_products
        where organization_id = '${ORG_A}' and codigo = 'INV-IP15';`,
    );
    expect(preco).toBe(String(PRECO_ORIGINAL + 100));
  });

  it("o manager da org A não muda o preço da org B", () => {
    // Ser `manager` em algum lugar não é ser manager em todo lugar — e o preço
    // do vizinho é o dado mais sensível deste catálogo.
    comoUsuario(
      MANAGER_A,
      `do $$ begin
         update public.catalog_products set preco_cents = 1
          where organization_id = '${ORG_B}' and codigo = 'INV-IP15';
       exception when others then null; end $$;
       select 1;`,
    );

    const preco = noBanco(
      `select preco_cents from public.catalog_products
        where organization_id = '${ORG_B}' and codigo = 'INV-IP15';`,
    );
    expect(preco).toBe(String(PRECO_ORIGINAL));
  });

  it("o manager da org B muda o dele (controle positivo do outro lado)", () => {
    comoUsuario(
      MANAGER_B,
      `update public.catalog_products set preco_cents = ${PRECO_ORIGINAL + 7}
        where organization_id = '${ORG_B}' and codigo = 'INV-IP15';
       select 1;`,
    );

    const preco = noBanco(
      `select preco_cents from public.catalog_products
        where organization_id = '${ORG_B}' and codigo = 'INV-IP15';`,
    );
    expect(preco).toBe(String(PRECO_ORIGINAL + 7));
  });

  it("a anon key não alcança o catálogo — o revoke, não só a policy", () => {
    // `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline
    // alcança toda tabela criada depois dele. Sem o revoke, o catálogo inteiro
    // fica legível pela chave que vai para o browser — e RLS sem GRANT negado
    // ainda deixa o PostgREST enumerar a tabela.
    const podeLer = noBanco(`
      select count(*) from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'catalog_products' and grantee = 'anon';
    `);
    expect(podeLer).toBe("0");
  });
});
