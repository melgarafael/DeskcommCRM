/**
 * `ai_provider_oauth` É SERVER-SIDE ONLY — E ISSO SE MEDE.
 *
 * ## O que se pagaria
 *
 * A tabela guarda o refresh token OAuth da assinatura ChatGPT da organização
 * (migration 0232, provider `openai-codex`). Quem lê o trio
 * (`refresh_encrypted`/`iv`/`tag`) com a chave de cifra da instalação troca por
 * um access token e fatura uso na assinatura do cliente. A anon key vai para o
 * browser — por isso `authenticated` não alcança coisa nenhuma: RLS ligada,
 * zero policies, grants revogados.
 *
 * ## Por que esta tabela NÃO está em `rls-isolation.test.ts`
 *
 * A ausência é deliberada e este arquivo é a contrapartida dela — o mesmo
 * desenho de `credencial-de-anuncios-e-server-side.test.ts` (molde copiado de
 * lá, inclusive a sonda mecânica abaixo). Aquele teste mede "o usuário da org
 * A vê ZERO linhas da org B" — pergunta que pressupõe que `authenticated`
 * ALCANÇA a tabela e é filtrado por policy. Aqui o psql devolveria
 * `permission denied` em vez de `0`, e a "correção" natural seria criar uma
 * policy — isto é, passar a SERVIR pelo PostgREST a tabela que guarda o token,
 * trocando a ausência de privilégio por uma regra que alguém pode errar
 * depois. Deny-all é MAIS restritivo que isolamento por tenant, não menos.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { motivoDoErro, sql } from "./psql-transporte";

/** A tabela do vínculo OAuth Codex, criada pela migration 0232. */
const TABELAS = ["ai_provider_oauth"] as const;

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
    // Acrescentar lá NÃO faria o teste medir mais: `countAs` roda
    // `set role authenticated`, e com privilégio NENHUM o psql devolve
    // `permission denied` em vez de `0`. O caso quebraria, e a "correção"
    // natural — criar uma policy para a contagem voltar a zero — passaria a
    // SERVIR pelo PostgREST a tabela que guarda o refresh token. Este caso
    // existe para que quem tentar leia o porquê ANTES de afrouxar o schema.
    // Lê o FONTE em vez de importar o módulo: `rls-isolation.test.ts` registra
    // `describe`/`beforeAll` no topo, e um `import` faria a suíte inteira dele
    // rodar de novo aqui dentro, semeando o mesmo banco duas vezes.
    const fonte = readFileSync(join(__dirname, "rls-isolation.test.ts"), "utf8");
    const lista = /export const TABLES = \[([\s\S]*?)\] as const;/.exec(fonte);
    expect(lista, "não achei `export const TABLES` no rls-isolation — a sonda cegou").not.toBeNull();

    // Só as linhas de VALOR: `"tabela",`. Um nome citado em comentário não
    // conta como estar na lista.
    const naLista = (lista?.[1] ?? "")
      .split("\n")
      .map((l) => /^\s*"([a-z_]+)",/.exec(l)?.[1])
      .filter((v): v is string => Boolean(v));
    expect(naLista.length, "extraí zero nomes da lista — a sonda cegou").toBeGreaterThan(5);

    expect(
      naLista.includes(tabela),
      `\`${tabela}\` entrou em TABLES do rls-isolation. Ela é deny-all (RLS ligada, ` +
        "zero policies, grants revogados): lá o caso vai falhar com `permission denied`, " +
        "e criar policy para consertá-lo expõe o refresh token pelo PostgREST. A prova dela é ESTE arquivo.",
    ).toBe(false);
  });
});

describe.each(TABELAS)("o PostgREST não serve `%s`", (tabela) => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    // Sem este caso, um nome de tabela errado (ou uma migration que nunca
    // chegou ao apêndice) devolveria NENHUM para todo mundo e os casos de
    // privilégio passariam por acidente, afirmando segurança sobre uma tabela
    // inexistente.
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
    // (lib/ai/codex/armazenamento.ts e o resolver do turno).
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo do papel que usa", () => {
    // Se ele sumir, o vínculo para de gravar/renovar e o produto degrada em
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
      "alguém criou policy: a tabela passa a ser SERVIDA pelo PostgREST, e o refresh " +
        "token fica atrás de uma regra em vez de atrás da ausência de privilégio",
    ).toBe("0");
  });

  it("é tenant-aware de verdade — `organization_id` NOT NULL com FK em cascata", () => {
    // O filtro manual do servidor precisa da coluna para se apoiar, e apagar a
    // organização não pode deixar o refresh token órfão vivo no banco.
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

describe("o refresh token é gravado cifrado", () => {
  // Os casos acima medem QUEM alcança a tabela, não O QUE está lá dentro:
  // gravar em texto puro passaria por todos eles.
  it("`refresh_encrypted`/`iv`/`tag` são bytea — o token não cabe em claro", () => {
    for (const coluna of ["refresh_encrypted", "refresh_iv", "refresh_tag"]) {
      const tipo = sql(`
        select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'ai_provider_oauth'
           and column_name = '${coluna}';
      `).trim();
      expect(tipo, `ai_provider_oauth.${coluna} não é bytea — o token cabe em claro`).toBe("bytea");
    }
  });
});
