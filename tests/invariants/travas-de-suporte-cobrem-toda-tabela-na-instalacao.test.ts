/**
 * AS TRAVAS DO MODO SOMENTE LEITURA DO SUPORTE COBREM TODA TABELA DO ESCOPO JÁ NA
 * PRIMEIRA APLICAÇÃO DO BASELINE — e a instalação nova chega ao MESMO conjunto que
 * a atualização.
 *
 * ## Por que este arquivo mede outro banco
 *
 * O molde padrão da suíte (`$TEST_DB_TEMPLATE`) recebe o baseline DUAS vezes
 * (install + update). A segunda passada faz tudo que a primeira deixou por fazer
 * por causa da ORDEM dentro do arquivo, então um invariante que só lê esse molde
 * não distingue "a instalação nova tem a propriedade" de "a primeira atualização a
 * completa". O `install.sh` aplica UMA vez. Por isso aqui o banco é uma cópia de
 * `$TEST_DB_TEMPLATE_UMA_APLICACAO`, que `scripts/test-db.sh` tira entre o install
 * e o update.
 *
 * E a posição dessa linha no script não é aceita por fé: se o molde fosse tirado
 * DEPOIS do update, todo o resto deste arquivo ficaria verde medindo a atualização.
 * O script grava uma linha em `test_db.aplicacoes_do_baseline` a cada aplicação, no
 * próprio banco, e o primeiro bloco daqui exige 1 no banco medido e 2 no molde padrão.
 *
 * ## O que se guarda
 *
 * 0. O INSTRUMENTO: o banco medido recebeu o baseline UMA vez; o molde padrão, DUAS
 *    (o segundo número prova que o contador está vivo).
 * 1. CATÁLOGO, sem tabela escrita à mão: a regra de seleção de
 *    `public.fn_aplicar_travas_de_suporte()` é perguntada ao `pg_class`, e toda
 *    tabela que ela alcança tem as três políticas restritivas `support_write_*`,
 *    para `authenticated`, no comando certo e com `fn_support_write_allowed` na
 *    expressão. A tabela só do servidor segue sem nenhuma. Os dois lados com
 *    guarda de vacuidade (contagem > 0).
 * 2. CONSISTÊNCIA: o conjunto de `support_write_*` de `public` com UMA aplicação é
 *    igual ao de DUAS.
 * 3. COMPORTAMENTO, na tabela do escopo criada por último. Ela é escolhida pelo
 *    catálogo, nunca por nome: maior `pg_class.oid` entre as tabelas que a regra
 *    alcança, em que `authenticated` pode inserir, alterar e apagar, e que aceitam
 *    uma linha só com `organization_id` (nenhuma outra coluna NOT NULL sem default).
 *    A sessão de suporte em modo somente leitura não insere, não altera e não apaga;
 *    a mesma sessão, o mesmo ator e a mesma tabela em modo completo fazem os três.
 *    A única variável entre os dois lados é o modo.
 */
import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
const moldeDuasAplicacoes = process.env.TEST_DB_TEMPLATE;
const moldeUmaAplicacao = process.env.TEST_DB_TEMPLATE_UMA_APLICACAO;
if (!container || !moldeDuasAplicacoes || !moldeUmaAplicacao) {
  throw new Error(
    "TEST_DB_CONTAINER/TEST_DB_TEMPLATE/TEST_DB_TEMPLATE_UMA_APLICACAO ausentes — rode via `pnpm test:db` " +
      "(scripts/test-db.sh), que tira o molde de aplicação única entre o install e o update.",
  );
}

const BANCO = "inv_travas_de_suporte_uma_aplicacao";

function psql(db: string, script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", container as string, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-qtA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Quantas aplicações do baseline o banco registrou (uma linha por aplicação, gravada por scripts/test-db.sh). */
const APLICACOES_DO_BASELINE = `
  select case when to_regclass('test_db.aplicacoes_do_baseline') is null then 'sem contador'
              else (select count(*)::text from test_db.aplicacoes_do_baseline) end;`;

/** A regra de seleção da função, sobre o catálogo aplicado. `gravavel` escolhe o lado. */
const REGRA = (gravavel: boolean) => `
  select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and (exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
          or c.relname = 'organizations')
     and ${gravavel ? "" : "not "}(has_table_privilege('authenticated', c.oid, 'insert')
          or has_table_privilege('authenticated', c.oid, 'update')
          or has_table_privilege('authenticated', c.oid, 'delete'))`;

/** Trava CORRETA: nome, restritiva, só `authenticated`, comando certo, guarda na expressão. */
const TRAVA_CORRETA = `
  select p.polrelid, p.polname from pg_policy p
   where not p.polpermissive
     and p.polroles = array[(select oid from pg_roles where rolname = 'authenticated')]::oid[]
     and (   (p.polname = 'support_write_insert' and p.polcmd = 'a'
              and pg_get_expr(p.polwithcheck, p.polrelid) like '%fn_support_write_allowed(%')
          or (p.polname = 'support_write_update' and p.polcmd = 'w'
              and pg_get_expr(p.polqual, p.polrelid) like '%fn_support_write_allowed(%'
              and pg_get_expr(p.polwithcheck, p.polrelid) like '%fn_support_write_allowed(%')
          or (p.polname = 'support_write_delete' and p.polcmd = 'd'
              and pg_get_expr(p.polqual, p.polrelid) like '%fn_support_write_allowed(%'))`;

const CONJUNTO_DE_TRAVAS = `
  select count(*) || '|' || coalesce(string_agg(c.relname || ':' || p.polname, ',' order by c.relname, p.polname), '')
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and p.polname like 'support_write\\_%';`;

/**
 * A tabela do escopo criada por último (maior `pg_class.oid`) que aceita uma linha
 * só com `organization_id` e que `authenticated` pode inserir, alterar e apagar.
 * Devolve o nome já citado (`quote_ident`), ou vazio se não houver nenhuma.
 */
const TABELA_CRIADA_POR_ULTIMO = `
  with alvo as (${REGRA(true)})
  select quote_ident(alvo.relname) from alvo
   where has_table_privilege('authenticated', alvo.oid, 'insert')
     and has_table_privilege('authenticated', alvo.oid, 'update')
     and has_table_privilege('authenticated', alvo.oid, 'delete')
     and exists (select 1 from pg_attribute a
                  where a.attrelid = alvo.oid and a.attname = 'organization_id' and not a.attisdropped)
     and not exists (select 1 from pg_attribute a
                      where a.attrelid = alvo.oid and a.attnum > 0 and not a.attisdropped
                        and a.attnotnull and not a.atthasdef and a.attidentity = '' and a.attgenerated = ''
                        and a.attname <> 'organization_id')
   order by alvo.oid desc
   limit 1;`;

beforeAll(() => {
  // DROP/CREATE DATABASE não rodam em bloco de transação: `-f -` manda statement a statement.
  psql(
    "template1",
    `drop database if exists ${BANCO} with (force);\ncreate database ${BANCO} template ${moldeUmaAplicacao};\n`,
  );
});

afterAll(() => {
  psql("template1", `drop database if exists ${BANCO} with (force);\n`);
});

describe("travas do modo somente leitura do suporte — baseline aplicado UMA vez", () => {
  describe("o instrumento: o banco medido é de uma aplicação do baseline", () => {
    it("o molde padrão registra DUAS aplicações (o contador está vivo)", () => {
      expect(
        psql(moldeDuasAplicacoes, APLICACOES_DO_BASELINE),
        "scripts/test-db.sh deixou de registrar cada aplicação do baseline em test_db.aplicacoes_do_baseline " +
          "(install + update = 2) — sem o contador, o caso seguinte não prova nada.",
      ).toBe("2");
    });

    it("o banco medido registra UMA aplicação (molde tirado entre o install e o update)", () => {
      const aplicacoes = psql(BANCO, APLICACOES_DO_BASELINE);
      expect(
        aplicacoes,
        `o molde $TEST_DB_TEMPLATE_UMA_APLICACAO registra ${aplicacoes} aplicação(ões) do baseline, e não 1: ` +
          "scripts/test-db.sh tem de tirá-lo DEPOIS do install e ANTES do update. Tirado depois do update, " +
          "este arquivo mede a atualização e fica verde mesmo quando a instalação nova difere dela.",
      ).toBe("1");
    });
  });

  it("toda tabela do escopo gravável pela sessão tem as três travas restritivas", () => {
    const saida = psql(
      BANCO,
      `with alvo as (${REGRA(true)}), trava as (${TRAVA_CORRETA})
       select count(*) || '|' || coalesce(string_agg(relname, ',' order by relname)
                filter (where (select count(*) from trava t where t.polrelid = alvo.oid) <> 3), '')
         from alvo;`,
    );
    const [alcancadas, semAsTres] = saida.split("|");

    // Vacuidade: uma regra que não alcança nada deixaria a lista abaixo vazia por ausência de dado.
    expect(Number(alcancadas), "a regra de seleção não alcançou tabela nenhuma").toBeGreaterThan(0);
    expect(semAsTres, `tabelas sem as três travas corretas após UMA aplicação: ${semAsTres}`).toBe("");
  });

  it("tabela do escopo só do servidor segue sem nenhuma trava support_write", () => {
    const saida = psql(
      BANCO,
      `with alvo as (${REGRA(false)})
       select count(*) || '|' || coalesce(string_agg(relname, ',' order by relname)
                filter (where exists (select 1 from pg_policy p
                                       where p.polrelid = alvo.oid and p.polname like 'support_write\\_%')), '')
         from alvo;`,
    );
    const [alcancadas, comTrava] = saida.split("|");

    expect(Number(alcancadas), "nenhuma tabela de organização só do servidor foi encontrada").toBeGreaterThan(0);
    expect(comTrava, `tabela só do servidor com trava support_write: ${comTrava}`).toBe("");
  });

  it("uma aplicação e duas aplicações chegam ao mesmo conjunto de travas", () => {
    const uma = psql(BANCO, CONJUNTO_DE_TRAVAS);
    const duas = psql(moldeDuasAplicacoes, CONJUNTO_DE_TRAVAS);

    expect(Number(uma.split("|")[0]), "nenhuma trava support_write em public").toBeGreaterThan(0);
    expect(uma).toBe(duas);
  });

  describe("comportamento: vale para toda tabela do escopo, inclusive a criada por último", () => {
    const ator = "f2740000-0000-4000-8000-000000000001";
    const sessao = "f2740000-0000-4000-8000-000000000002";
    const orgA = "f2740000-0000-4000-8000-000000000004";
    const orgB = "f2740000-0000-4000-8000-000000000005";

    let tabelaMemo: string | undefined;
    /** `public.<nome citado>` da tabela escolhida pelo catálogo; lança se não houver nenhuma. */
    function tabela(): string {
      tabelaMemo ??= psql(BANCO, TABELA_CRIADA_POR_ULTIMO);
      if (tabelaMemo === "") {
        throw new Error(
          "nenhuma tabela do escopo aceita uma linha só com organization_id e é gravável por authenticated",
        );
      }
      return `public.${tabelaMemo}`;
    }

    const semente = `begin;
insert into auth.users(id,email) values('${ator}','support-trava@invariant.test');
insert into auth.sessions(id,user_id,aal) values('${sessao}','${ator}','aal1');
insert into organizations(id,slug,display_name,legal_name) values('${orgA}','trava-a','A','A'),('${orgB}','trava-b','B','B');
insert into user_organizations(organization_id,user_id,role,accepted_at) values('${orgA}','${ator}','admin',now());
insert into platform_admins(user_id,granted_by,scope,mfa_required,reason) values('${ator}','${ator}','full',false,'Local test');`;

    const entrar = (modo: "full" | "support_readonly") => `
select fn_start_support('${ator}','${sessao}','${orgB}','${orgA}','${modo}',3600);
select set_config('request.jwt.claims','{"sub":"${ator}","session_id":"${sessao}","aal":"aal1"}',true);
do $$ begin
  if fn_support_context()->>'access_mode' is distinct from '${modo}' or fn_support_context()->>'status' <> 'active' then
    raise exception 'sessão de suporte não ficou ativa no modo ${modo}: %', fn_support_context();
  end if;
end $$;
set local role authenticated;`;

    function provar(corpo: string) {
      expect(psql(BANCO, `${semente}\n${corpo}\nrollback;\nselect 'provado';`)).toContain("provado");
    }

    it("a tabela do escopo criada por último é encontrada pelo catálogo", () => {
      expect(tabela()).toMatch(/^public\./);
    });

    it("modo somente leitura: insert é recusado pela trava", () =>
      provar(`${entrar("support_readonly")}
do $$ begin
  begin
    insert into ${tabela()}(organization_id) values ('${orgB}');
    raise exception 'insert passou em modo somente leitura';
  exception when insufficient_privilege then
    if sqlerrm not like '%support_write_insert%' then
      raise exception 'insert recusado por outro motivo: %', sqlerrm;
    end if;
  end;
end $$;`));

    it("modo somente leitura: update e delete não alcançam a linha", () =>
      provar(`insert into ${tabela()}(organization_id) values ('${orgB}');
select set_config('inv.ctid', (select ctid::text from ${tabela()} where organization_id = '${orgB}'), true);
${entrar("support_readonly")}
do $$ declare n int; begin
  update ${tabela()} set organization_id = organization_id where organization_id = '${orgB}';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'update alcançou % linha(s) em modo somente leitura', n; end if;
  delete from ${tabela()} where organization_id = '${orgB}';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'delete alcançou % linha(s) em modo somente leitura', n; end if;
end $$;
reset role;
do $$ begin
  if (select ctid::text from ${tabela()} where organization_id = '${orgB}') is distinct from current_setting('inv.ctid') then
    raise exception 'a linha mudou ou sumiu em modo somente leitura';
  end if;
end $$;`));

    it("modo completo (controle): insert, update e delete gravam na mesma tabela", () =>
      provar(`${entrar("full")}
do $$ declare n int; begin
  insert into ${tabela()}(organization_id) values ('${orgB}');
  update ${tabela()} set organization_id = organization_id where organization_id = '${orgB}';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'update em modo completo alcançou % linha(s)', n; end if;
  delete from ${tabela()} where organization_id = '${orgB}';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'delete em modo completo alcançou % linha(s)', n; end if;
end $$;`));
  });
});
