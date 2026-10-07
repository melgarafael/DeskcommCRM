import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A LEITURA DO CATÁLOGO NÃO PAGA A REGRA DE ESCRITA (migration 0553).
 *
 * `catalog_products_write` era `for all`, e `for all` vale também para SELECT:
 * o Postgres junta as permissivas por OR, e o plano avaliava
 * `fn_role_at_least(organization_id, 'manager')` — `security definer`, que não
 * se expande na consulta — em CADA linha da organização, antes do filtro da
 * busca. Medido em pg15 com 579 produtos, como `authenticated`: 1.204 ms a
 * contagem, ~2 ms por produto. A tela de Produtos estourava o
 * `statement_timeout` de 8 s e mostrava "Algo deu errado" — foi o e2e do #2138
 * (`catalogo-busca-no-catalogo-inteiro.spec.ts`, @valterhjr) que pegou.
 *
 * A prova é o PLANO da leitura, como `authenticated`: tempo é ruído de máquina,
 * o plano não. Com o `for all` de volta, o filtro cita a função e o caso reprova
 * (sabotado antes do commit: 2 vermelhos, os dois primeiros casos).
 *
 * Conectar como `postgres` mediria NADA (rolbypassrls = t).
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

function comoUsuario(userId: string, script: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
}

function noBanco(script: string): string {
  return sql(`reset role;\n${script}`).split("\n").pop() ?? "";
}

const ORG = "dddddddd-0553-4000-8000-00000000000a";
const MANAGER = "dddddddd-0553-4000-8000-0000000000a1";
const AGENT = "dddddddd-0553-4000-8000-0000000000a2";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER}', 'catalogo-0553-mgr@invariant.test'),
      ('${AGENT}',   'catalogo-0553-agent@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'catalogo-0553', 'Catalogo 0553', 'Catalogo 0553')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER}', '${ORG}', 'manager', now()),
      ('${AGENT}',   '${ORG}', 'agent',   now())
      on conflict do nothing;
  `);
});

describe("catalog_products — a leitura não avalia a regra de escrita", () => {
  it("o plano da contagem do catálogo não chama fn_role_at_least nem o _full", () => {
    const plano = comoUsuario(
      MANAGER,
      `explain (costs off, verbose) select count(*) from public.catalog_products
        where organization_id = '${ORG}' and nome ilike '%iphone%';`,
    );
    // Controle positivo: é mesmo o plano com a RLS (sem ele, um plano vazio passaria).
    expect(plano).toContain("fn_user_org_ids");
    expect(plano).not.toContain("fn_role_at_least");
    expect(plano).not.toContain("fn_is_platform_admin_full");
  });

  it("nenhuma policy além da de leitura vale para SELECT", () => {
    const n = noBanco(`
      select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'catalog_products'
         and cmd in ('ALL', 'SELECT') and policyname <> 'catalog_products_select';
    `);
    expect(n).toBe("0");
  });

  it("o manager CADASTRA e APAGA; o agent não apaga (o trio cobre o que o for all cobria)", () => {
    const quantos = () =>
      noBanco(`select count(*) from public.catalog_products where codigo = 'INV-0553';`);

    comoUsuario(
      MANAGER,
      `insert into public.catalog_products (organization_id, codigo, nome, preco_cents)
         values ('${ORG}', 'INV-0553', 'Sonda da 0553', 100) on conflict do nothing;`,
    );
    expect(quantos()).toBe("1");

    comoUsuario(
      AGENT,
      `do $$ begin
         delete from public.catalog_products where organization_id = '${ORG}' and codigo = 'INV-0553';
       exception when others then null; end $$;`,
    );
    expect(quantos()).toBe("1");

    comoUsuario(
      MANAGER,
      `delete from public.catalog_products where organization_id = '${ORG}' and codigo = 'INV-0553';`,
    );
    expect(quantos()).toBe("0");
  });
});
