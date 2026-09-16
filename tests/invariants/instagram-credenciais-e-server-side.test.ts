/**
 * AS DUAS TABELAS DE CREDENCIAL DO INSTAGRAM SÃO SERVER-SIDE ONLY.
 *
 * Irmã declarada de `credencial-de-anuncios-e-server-side.test.ts` (o molde) e
 * de `google-ads-captura-e-server-side.test.ts`. `instagram_apps` guarda o App
 * Secret que assina toda chamada feita em nome de QUALQUER lead conectado;
 * `instagram_connections` guarda o token OAuth que publica de fato na conta
 * Instagram de cada lead. Os dois são segredo de verdade, e a anon key vai
 * para o browser.
 *
 * Escrita neste PR de Google Ads porque o mesmo gate de CI
 * (`rls-completude-varredura.test.ts`) que cobrou prova para
 * `google_ads_landing_pages`/`google_ads_click_refs` cobrou, na mesma
 * varredura, prova para estas duas — dívida herdada do recurso de Instagram,
 * que nunca ganhou este teste. Não muda nada no schema: as duas tabelas já
 * nasceram deny-all nas migrations 0266/0267; só faltava a prova.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = ["instagram_apps", "instagram_connections"] as const;

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function esperaBarrado(papel: string, comando: string): void {
  const erro = erroSob(papel, comando);
  expect(erro, `\`${papel}\` executou "${comando}" SEM erro — a tabela está exposta`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function privilegiosDe(papel: string, tabela: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = '${tabela}'
       and grantee = '${papel}';
  `).trim();
}

describe("a lista do `rls-isolation` e esta não se sobrepõem", () => {
  it.each(TABELAS)("`%s` NÃO está em `TABLES` do rls-isolation — e não pode entrar", (tabela) => {
    const fonte = readFileSync(join(__dirname, "rls-isolation.test.ts"), "utf8");
    const lista = /export const TABLES = \[([\s\S]*?)\] as const;/.exec(fonte);
    expect(lista, "não achei `export const TABLES` no rls-isolation — a sonda cegou").not.toBeNull();

    const naLista = (lista?.[1] ?? "")
      .split("\n")
      .map((l) => /^\s*"([a-z_]+)",/.exec(l)?.[1])
      .filter((v): v is string => Boolean(v));
    expect(naLista.length, "extraí zero nomes da lista — a sonda cegou").toBeGreaterThan(5);

    expect(
      naLista.includes(tabela),
      `\`${tabela}\` entrou em TABLES do rls-isolation. Ela é deny-all (RLS ligada, ` +
        "zero policies, grants revogados): lá o caso vai falhar com `permission denied`, " +
        "e criar policy para consertá-lo expõe o segredo pelo PostgREST. A prova dela é ESTE arquivo.",
    ).toBe(false);
  });
});

describe.each(TABELAS)("o PostgREST não serve `%s`", (tabela) => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    const existe = sql(`
      select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = '${tabela}';
    `).trim();
    expect(existe, `\`${tabela}\` não está no baseline — o kit self-host não a cria`).toBe("1");
  });

  it("`anon` não tem privilégio NENHUM", () => {
    expect(privilegiosDe("anon", tabela)).toBe("NENHUM");
  });

  it("`authenticated` também não tem — nenhuma tela lê isto pelo client de sessão", () => {
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo do papel que usa", () => {
    const privilegios = privilegiosDe("service_role", tabela);
    expect(privilegios).toContain("SELECT");
    expect(privilegios).toContain("INSERT");
    expect(privilegios).toContain("UPDATE");
  });

  it("`anon` é BARRADO ao ler — permission denied, não zero linhas", () => {
    esperaBarrado("anon", `select organization_id from public.${tabela}`);
  });

  it("`authenticated` é BARRADO ao ler", () => {
    esperaBarrado("authenticated", `select organization_id from public.${tabela}`);
  });

  it("a RLS está LIGADA — o segundo degrau, para o dia em que o grant voltar", () => {
    const ligada = sql(`
      select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;
    `).trim();
    expect(ligada, "RLS desligada: o revoke vira a única defesa").toBe("t");
  });

  it("não há policy nenhuma — servir esta tabela nunca foi a intenção", () => {
    const quantas = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and tablename = '${tabela}';
    `).trim();
    expect(
      quantas,
      "alguém criou policy: a tabela passa a ser SERVIDA pelo PostgREST",
    ).toBe("0");
  });

  it("é tenant-aware de verdade — `organization_id` NOT NULL com FK em cascata", () => {
    const coluna = sql(`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = '${tabela}'
         and column_name = 'organization_id';
    `).trim();
    expect(coluna, `\`${tabela}\` não tem organization_id`).toBe("NO");

    const cascata = sql(`
      select count(*) from information_schema.table_constraints tc
       join information_schema.referential_constraints rc
         on rc.constraint_name = tc.constraint_name
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
       where tc.table_schema = 'public' and tc.table_name = '${tabela}'
         and tc.constraint_type = 'FOREIGN KEY'
         and kcu.column_name = 'organization_id'
         and rc.delete_rule = 'CASCADE';
    `).trim();
    expect(cascata, "a FK de organization_id não é ON DELETE CASCADE").not.toBe("0");
  });
});

describe("o token/segredo é gravado cifrado", () => {
  it("app_secret_encrypted e access_token_encrypted são bytea", () => {
    const colunas: [string, string][] = [
      ["instagram_apps", "app_secret_encrypted"],
      ["instagram_connections", "access_token_encrypted"],
    ];
    for (const [tabela, coluna] of colunas) {
      const tipo = sql(`
        select data_type from information_schema.columns
         where table_schema = 'public' and table_name = '${tabela}'
           and column_name = '${coluna}';
      `).trim();
      expect(tipo, `${tabela}.${coluna} não é bytea — o segredo cabe em claro`).toBe("bytea");
    }
  });
});
