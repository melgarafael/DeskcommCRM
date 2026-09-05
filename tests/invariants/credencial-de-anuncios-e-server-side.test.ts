/**
 * AS TRÊS TABELAS DE ANÚNCIO SÃO SERVER-SIDE ONLY — E ISSO SE MEDE.
 *
 * ## O que se pagaria
 *
 * `ad_platform_connections` guarda o token que ESCREVE conversões no dataset da
 * Meta; `ad_insights_connections`, o token `ads_read` que lê orçamento,
 * criativo e performance de quem anuncia; `ad_conversion_dispatches`, o
 * livro-razão de quais leads da organização viraram venda. Os três são dado
 * comercial, e o primeiro deixa terceiro INJETAR conversão falsa na conta de
 * anúncios do cliente. A anon key vai para o browser.
 *
 * ## Por que estas tabelas NÃO estão em `rls-isolation.test.ts`
 *
 * A ausência é deliberada e este arquivo é a contrapartida dela. Aquele teste
 * mede "o usuário da org A vê ZERO linhas da org B" — pergunta que pressupõe
 * que `authenticated` ALCANÇA a tabela e é filtrado por policy. Aqui
 * `authenticated` não alcança coisa nenhuma: RLS ligada, zero policies, grants
 * revogados. Rodar o molde de lá devolveria `permission denied` em vez de `0`,
 * e a "correção" natural seria criar uma policy — isto é, passar a SERVIR pelo
 * PostgREST a tabela que guarda o token, trocando a ausência de privilégio por
 * uma regra que alguém pode errar depois. Deny-all é MAIS restritivo que
 * isolamento por tenant, não menos.
 *
 * Irmão declarado de `credencial-do-google-e-server-side.test.ts`, que é o
 * molde, e do desenho de `platform_google_oauth` (0201).
 *
 * A ligação entre os dois arquivos é MECÂNICA, não um comentário lá que alguém
 * precise lembrar de ler: o caso "não está na lista do outro" importa a
 * constante `TABLES` dele e reprova se alguém acrescentar uma destas três.
 * `tests/invariants/**` é congelado por hook de pre-commit, então a guarda que
 * liga os dois tinha de morar do lado que não é congelado — este.
 *
 * ## Por que RLS-sem-policy não basta sozinha
 *
 * O `supabase/baseline.sql` traz `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
 * TABLES TO anon` / `... TO authenticated`, e eles valem para toda tabela criada
 * DEPOIS deles — isto é, para todo apêndice novo. **Tabela nova nasce
 * concedida.** Com RLS ligada e zero policies, `anon` recebe zero linhas mesmo
 * SEM o revoke, e um teste que contasse linhas passaria. Por isso aqui se mede
 * PRIVILÉGIO (o que sobra no dia em que alguém acrescentar uma policy de
 * leitura) **e** comportamento (`permission denied`, que distingue "a policy
 * barrou" de "o privilégio não existe").
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { motivoDoErro, sql } from "./psql-transporte";

/** As três tabelas do eixo de anúncios, criadas pelas migrations 0213 e 0214. */
const TABELAS = [
  "ad_platform_connections",
  "ad_conversion_dispatches",
  "ad_insights_connections",
] as const;

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/**
 * Afirma que o Postgres RECUSOU por privilégio.
 *
 * O modo de falha interessante é `erroSob` devolver `null`: o comando PASSOU.
 * Com o grant de volta, `anon` recebe zero linhas SEM erro — e um `toContain`
 * sobre `null` reprovaria com uma mensagem que não diz nada sobre exposição.
 */
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
    // Acrescentar uma destas lá NÃO faria o teste medir mais: `countAs` roda
    // `set role authenticated`, e com privilégio NENHUM o psql devolve
    // `permission denied` em vez de `0`. O caso quebraria, e a "correção"
    // natural — criar uma policy para a contagem voltar a zero — passaria a
    // SERVIR pelo PostgREST a tabela que guarda o token da conta de anúncios.
    //
    // Este caso existe para que quem tentar leia o porquê ANTES de afrouxar o
    // schema, em vez de descobrir pelo vermelho e escolher o caminho errado.
    // Lê o FONTE em vez de importar o módulo: `rls-isolation.test.ts` registra
    // `describe`/`beforeAll` no topo, e um `import` faria a suíte inteira dele
    // rodar de novo aqui dentro, semeando o mesmo banco duas vezes.
    const fonte = readFileSync(join(__dirname, "rls-isolation.test.ts"), "utf8");
    const lista = /export const TABLES = \[([\s\S]*?)\] as const;/.exec(fonte);
    expect(lista, "não achei `export const TABLES` no rls-isolation — a sonda cegou").not.toBeNull();

    // Só as linhas de VALOR: `"tabela",`. Um nome citado em comentário — e este
    // arquivo é citado lá — não conta como estar na lista.
    const naLista = (lista?.[1] ?? "")
      .split("\n")
      .map((l) => /^\s*"([a-z_]+)",/.exec(l)?.[1])
      .filter((v): v is string => Boolean(v));
    expect(naLista.length, "extraí zero nomes da lista — a sonda cegou").toBeGreaterThan(5);

    expect(
      naLista.includes(tabela),
      `\`${tabela}\` entrou em TABLES do rls-isolation. Ela é deny-all (RLS ligada, ` +
        "zero policies, grants revogados): lá o caso vai falhar com `permission denied`, " +
        "e criar policy para consertá-lo expõe o token pelo PostgREST. A prova dela é ESTE arquivo.",
    ).toBe(false);
  });
});

describe.each(TABELAS)("o PostgREST não serve `%s`", (tabela) => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    // Sem este caso, um nome de tabela errado (ou uma migration que nunca
    // chegou ao apêndice, que é exatamente o defeito que este PR tinha)
    // devolveria NENHUM para todo mundo e os casos de privilégio passariam por
    // acidente, afirmando segurança sobre uma tabela inexistente.
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
    // Quem lê é o servidor, com o admin client, filtrando organization_id à mão
    // (`lib/plataformas-de-anuncio/credenciais.ts` e `credenciais-de-leitura.ts`).
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo do papel que usa", () => {
    // Se ele sumir, a tela para de gravar a credencial e o produto degrada em
    // silêncio, sem ninguém entender por quê.
    const privilegios = privilegiosDe("service_role", tabela);
    expect(privilegios).toContain("SELECT");
    expect(privilegios).toContain("INSERT");
    expect(privilegios).toContain("UPDATE");
  });

  it("`anon` é BARRADO ao ler — permission denied, não zero linhas", () => {
    esperaBarrado("anon", `select id from public.${tabela}`);
  });

  it("`authenticated` é BARRADO ao ler", () => {
    esperaBarrado("authenticated", `select id from public.${tabela}`);
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
      "alguém criou policy: a tabela passa a ser SERVIDA pelo PostgREST, e o token " +
        "fica atrás de uma regra em vez de atrás da ausência de privilégio",
    ).toBe("0");
  });

  it("é tenant-aware de verdade — `organization_id` NOT NULL com FK em cascata", () => {
    // As três carregam dado de UMA organização. Sem a coluna (ou com ela
    // nullable) o filtro manual do handler não teria em que se apoiar, e apagar
    // a organização deixaria o token órfão vivo no banco.
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

describe("o token é gravado cifrado, e volta pela decifra", () => {
  // A propriedade que a tela promete quando diz que o token "não volta a
  // aparecer". Os casos acima medem QUEM alcança a tabela, não O QUE está lá
  // dentro: gravar em texto puro passaria por todos eles.
  it("`access_token_encrypted` é bytea nas duas tabelas de credencial", () => {
    for (const tabela of ["ad_platform_connections", "ad_insights_connections"]) {
      const tipo = sql(`
        select data_type from information_schema.columns
         where table_schema = 'public' and table_name = '${tabela}'
           and column_name = 'access_token_encrypted';
      `).trim();
      expect(tipo, `${tabela}.access_token_encrypted não é bytea — o token cabe em claro`).toBe(
        "bytea",
      );
    }
  });
});
