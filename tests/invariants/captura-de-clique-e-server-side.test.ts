/**
 * AS QUATRO TABELAS DE CAPTURA DE CLIQUE SÃO SERVER-SIDE ONLY.
 *
 * Irmã declarada de `credencial-de-anuncios-e-server-side.test.ts` (o molde) e
 * de `credencial-do-google-e-server-side.test.ts`. Mesmo raciocínio, tabelas
 * diferentes: as `*_landing_pages` guardam para qual WhatsApp e com qual texto
 * a captura redireciona; as `*_click_refs` guardam o que foi capturado (o
 * `gclid` do clique pago, no eixo do Google Ads; as UTMs da página, no da
 * Meta) e o token curto que liga aquilo à mensagem. Nenhuma das quatro é
 * segredo no sentido de token de API, mas todas são dado comercial da
 * organização — o `gclid` identifica o clique pago de um cliente específico, e
 * a UTM diz em que campanha a organização gasta —, e nenhuma tela as lê pelo
 * client de sessão: quem lê é o servidor, com o admin client, filtrando
 * `organization_id` à mão (`lib/plataformas-de-anuncio/landing-config.ts` e
 * `captura-de-clique.ts`).
 *
 * O arquivo nasceu com as duas tabelas da 0306 e o nome falava só do Google; a
 * 0381 acrescentou o par da Meta com o MESMO desenho, e a escolha aqui foi
 * medir as quatro no mesmo `describe.each` em vez de abrir um segundo arquivo
 * quase idêntico — a régua é a mesma, e duas cópias dela divergiriam.
 *
 * Por que estas tabelas NÃO estão em `rls-isolation.test.ts`: a ausência é
 * deliberada, pelo mesmo motivo do molde — RLS ligada, zero policies, grants
 * revogados de anon/authenticated. `authenticated` não alcança a tabela de
 * jeito nenhum, então o molde de `rls-isolation` (que pressupõe que a policy
 * FILTRA por tenant) devolveria `permission denied` em vez de `0`, e a
 * "correção" natural seria criar uma policy — abrindo pelo PostgREST uma
 * tabela que hoje só o `service_role` alcança.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { motivoDoErro, sql } from "./psql-transporte";

/** As duas tabelas da migration 0306 e as duas da 0381. */
const TABELAS = [
  "google_ads_landing_pages",
  "google_ads_click_refs",
  "meta_ads_landing_pages",
  "meta_ads_click_refs",
] as const;

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
        "e criar policy para consertá-lo expõe a tabela pelo PostgREST. A prova dela é ESTE arquivo.",
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
