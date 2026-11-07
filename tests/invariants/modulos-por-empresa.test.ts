import { beforeAll, describe, expect, it } from "vitest";

import { countAs, GOV_AGENT_A, sql, tableExists } from "./gov-helpers";

/**
 * `organization_modules` — o módulo opcional POR EMPRESA (migration 9217, #3868).
 *
 * ─── Por que este arquivo existe ─────────────────────────────────────────────
 *
 * A tabela nasceu tenant-aware (`organization_id not null`), e a varredura de
 * completude exige prova comportamental para TABELA NOVA. Ela NÃO entra em
 * `TABLES` porque `authenticated` não tem SELECT nenhum — o controle positivo de
 * lá falharia por ACERTO. É a classe "tabela exclusiva do servidor", a mesma de
 * `automation_rule_contact_claims` e `lgpd_marcas_de_apagamento`: a decisão é do
 * servidor, e nenhum papel de navegador a lê nem a escreve — nem a da própria
 * organização.
 *
 * ─── O que se prova aqui ────────────────────────────────────────────────────
 *
 *  - a tabela, a PK, os dois CHECKs e a FK em cascata existem no banco que a
 *    CADEIA de migrations produz (não só no `baseline.sql`);
 *  - `ligado`/`desligado` são os únicos estados, e o formato do módulo é
 *    identificador — lixo de SQL manual é recusado pelo banco;
 *  - anon/authenticated sem privilégio; service_role com os quatro verbos;
 *  - DESLIGAR NÃO APAGA DADO: a linha de um módulo real (`attendant_sectors`, do
 *    módulo `setores`) continua lá com a empresa em `desligado` e volta a valer
 *    ao religar — a decisão é uma linha, não uma operação destrutiva.
 */
const ORG_A = "cccccccc-9216-4000-8000-000000000001";
const ORG_B = "cccccccc-9216-4000-8000-000000000002";
const SETOR = "cccccccc-9216-5000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'modulos-por-empresa-a', 'Empresa A', 'Empresa A'),
      ('${ORG_B}', 'modulos-por-empresa-b', 'Empresa B', 'Empresa B')
      on conflict (id) do nothing;
    insert into public.attendant_sectors (id, organization_id, name)
      values ('${SETOR}', '${ORG_A}', 'Comercial')
      on conflict (id) do nothing;
  `);
});

describe("migration 9217 — a forma da tabela", () => {
  it("existe, com organization_id, modulo, estado, updated_at e updated_by", () => {
    expect(tableExists("organization_modules")).toBe(true);
    for (const coluna of ["organization_id", "modulo", "estado", "updated_at", "updated_by"]) {
      expect(
        sql(
          `select count(*) from information_schema.columns
            where table_schema = 'public' and table_name = 'organization_modules' and column_name = '${coluna}'`,
        ),
      ).toBe("1");
    }
  });

  it("a PK é (organization_id, modulo) — a exceção é uma por empresa e módulo", () => {
    expect(
      sql(
        `select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'public.organization_modules'::regclass and contype = 'p'`,
      ),
    ).toContain("(organization_id, modulo)");
  });

  it("os dois CHECKs e a FK em cascata estão no banco da CADEIA", () => {
    const definicoes = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.organization_modules'::regclass order by conname`,
    );
    expect(definicoes).toContain("estado = ANY");
    expect(definicoes).toContain("modulo ~");
    expect(definicoes).toContain("ON DELETE CASCADE");
  });

  it("RLS ligada e ZERO policies — decisão do servidor, não da sessão", () => {
    expect(
      sql(`select relrowsecurity from pg_class where oid = 'public.organization_modules'::regclass`),
    ).toBe("t");
    expect(
      sql(
        `select count(*) from pg_policies where schemaname = 'public' and tablename = 'organization_modules'`,
      ),
    ).toBe("0");
  });

  it("anon e authenticated SEM privilégio; service_role com os quatro verbos", () => {
    expect(
      sql(
        `select bool_and(not has_table_privilege(r, 'public.organization_modules', 'select'))
           from unnest(array['anon','authenticated']) r`,
      ),
    ).toBe("t");
    expect(
      sql(
        `select bool_and(has_table_privilege('service_role', 'public.organization_modules', v))
           from unnest(array['select','insert','update','delete']) v`,
      ),
    ).toBe("t");
  });

  it("o JWT de um membro da própria organização não lê a tabela", () => {
    expect(() =>
      countAs(GOV_AGENT_A, `select count(*) from public.organization_modules;`),
    ).toThrow();
  });
});

describe("o banco recusa estado e módulo inválidos (o 500 nunca acontece na ação)", () => {
  it("estado fora de ligado/desligado é recusado pela CHECK", () => {
    // O `psql` sem `VERBOSITY verbose` não imprime o SQLSTATE (23514), então a
    // asserção é pelo NOME da constraint — que é o que o código do banco vê.
    expect(() =>
      sql(`insert into public.organization_modules (organization_id, modulo, estado)
           values ('${ORG_A}', 'propostas', 'talvez');`),
    ).toThrow(/organization_modules_estado_valido/);
  });

  it("módulo com formato de identificador é o único aceito", () => {
    expect(() =>
      sql(`insert into public.organization_modules (organization_id, modulo, estado)
           values ('${ORG_A}', 'Propostas Ou Nada', 'ligado');`),
    ).toThrow(/organization_modules_modulo_formato/);
    // E o formato válido entra.
    sql(`insert into public.organization_modules (organization_id, modulo, estado)
         values ('${ORG_A}', 'crm_b2b', 'desligado') on conflict do nothing;`);
    expect(
      sql(`select count(*) from public.organization_modules where organization_id = '${ORG_A}';`),
    ).not.toBe("0");
  });

  it("a mesma empresa não guarda duas linhas do mesmo módulo (PK)", () => {
    expect(() =>
      sql(`insert into public.organization_modules (organization_id, modulo, estado)
           values ('${ORG_A}', 'crm_b2b', 'ligado');`),
    ).toThrow(/organization_modules_pkey/);
  });

  it("a mesma decisão em empresas diferentes convive", () => {
    sql(`insert into public.organization_modules (organization_id, modulo, estado)
         values ('${ORG_B}', 'crm_b2b', 'ligado') on conflict do nothing;`);
    expect(
      sql(`select count(*) from public.organization_modules where modulo = 'crm_b2b';`),
    ).toBe("2");
  });

  it("apagar a organização leva as linhas junto (cascata)", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('cccccccc-9216-4000-8000-00000000000f', 'modulos-por-empresa-apagar', 'Apagar', 'Apagar')
        on conflict (id) do nothing;
      insert into public.organization_modules (organization_id, modulo, estado)
        values ('cccccccc-9216-4000-8000-00000000000f', 'setores', 'desligado') on conflict do nothing;
      delete from public.organizations where id = 'cccccccc-9216-4000-8000-00000000000f';
    `);
    expect(
      sql(
        `select count(*) from public.organization_modules
          where organization_id = 'cccccccc-9216-4000-8000-00000000000f';`,
      ),
    ).toBe("0");
  });
});

describe("desligar um módulo NÃO apaga dado", () => {
  it("os setores da empresa continuam lá com `setores` desligado, e voltam ao religar", () => {
    // A decisão: desligado para a empresa A.
    sql(`insert into public.organization_modules (organization_id, modulo, estado)
         values ('${ORG_A}', 'setores', 'desligado')
         on conflict (organization_id, modulo) do update set estado = 'desligado';`);

    expect(
      sql(`select count(*) from public.attendant_sectors where organization_id = '${ORG_A}';`),
    ).toBe("1");
    expect(
      sql(`select name from public.attendant_sectors where id = '${SETOR}';`),
    ).toBe("Comercial");

    // Religar é trocar UMA linha — e o setor continua o mesmo, com o mesmo nome.
    sql(`update public.organization_modules set estado = 'ligado'
          where organization_id = '${ORG_A}' and modulo = 'setores';`);

    expect(
      sql(`select count(*) from public.attendant_sectors where organization_id = '${ORG_A}';`),
    ).toBe("1");
    expect(
      sql(`select estado from public.organization_modules
            where organization_id = '${ORG_A}' and modulo = 'setores';`),
    ).toBe("ligado");
  });

  it("devolver a empresa ao padrão apaga SÓ a linha da decisão", () => {
    const setoresAntes = sql(
      `select count(*) from public.attendant_sectors where organization_id = '${ORG_A}';`,
    );
    sql(`delete from public.organization_modules
          where organization_id = '${ORG_A}' and modulo = 'setores';`);
    expect(
      sql(`select count(*) from public.organization_modules
            where organization_id = '${ORG_A}' and modulo = 'setores';`),
    ).toBe("0");
    expect(
      sql(`select count(*) from public.attendant_sectors where organization_id = '${ORG_A}';`),
    ).toBe(setoresAntes);
  });
});
