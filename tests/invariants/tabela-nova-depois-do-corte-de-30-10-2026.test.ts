import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * TABELA CRIADA DEPOIS DE 30/10/2026 NASCE ALCANÇÁVEL PELA DATA API — PORQUE A
 * MIGRATION 9029 REESCREVE O DEFAULT ACL QUE A SUPABASE VAI REVOGAR.
 *
 * ## O corte, e por que um teste de `has_table_privilege` "normal" nasceria verde
 *
 * A partir de 30/10/2026 a Supabase para de conceder `select/insert/update/delete`
 * a `anon`, `authenticated` e `service_role` em tabela NOVA de `public`, nos
 * projetos da nuvem. O mecanismo não é `revoke` nas tabelas: é o DEFAULT ACL
 * (`pg_default_acl`) que a plataforma passa a provisionar revogado
 * (discussão oficial #45329). Tabela nova nasce sem `GRANT`, e o PostgREST —
 * caminho do supabase-js e da REST — responde `42501 permission denied`.
 *
 * No banco deste gate o defeito NÃO PODE existir espontaneamente: o prelude do
 * `scripts/test-db.sh` instala exatamente o default ACL de um projeto Supabase
 * (`grant all on tables` para os três roles) e o corpo do baseline o reemite. Um
 * teste que só criasse uma tabela e perguntasse pelo privilégio mediria o BANCO
 * DE HOJE, não o de 30/10 — verde por construção, e verde também com a migration
 * apagada. É a mesma armadilha que `definer-nova-nasce-exposta.test.ts` registrou
 * no eixo das funções.
 *
 * Por isso aqui o corte é SIMULADO, e a simulação tem de morder: antes de medir a
 * cura, o arquivo confere que uma tabela criada logo depois do `revoke all` não é
 * alcançável por `authenticated`. Sem essa metade, um `revoke` que não fizesse
 * nada deixaria todo o resto verde.
 *
 * ## O que se aplica, e de onde
 *
 * Duas origens, e as duas são medidas porque são dois públicos:
 *
 *   1. o ARQUIVO da migration (`supabase/migrations/…_9029_….sql`) — quem instala
 *      pelo Supabase CLI aplica a cadeia, nunca o baseline;
 *   2. o BLOCO DO APÊNDICE, extraído do `baseline.sql` na posição em que ele vive
 *      — quem instala pelo kit self-host aplica só o baseline (`install.sh` /
 *      `update.sh`). Extrair em vez de reescrever é o que dá valor ao teste: uma
 *      cópia digitada aqui continuaria passando com o bloco apagado do baseline.
 *
 * ## Quantas tabelas dependem do default ACL: derivado, não digitado
 *
 * O tamanho do problema — quantas tabelas o apêndice cria e quantas delas não têm
 * `GRANT` próprio — sai de `tabelasDoApendiceSemGrantProprio()`, que lê o
 * `baseline.sql` desta árvore. Número copiado envelhece em silêncio: o apêndice
 * ganha tabela toda semana, e um literal digitado aqui viraria ficção sem ninguém
 * notar. A lista derivada é a régua, e o caso confere no banco que cada nome dela
 * existe de verdade — parser que lesse `create table` de prosa produziria nome
 * fantasma e passaria medindo nada.
 *
 * ## `anon`: restauração, não ampliação
 *
 * A migration devolve o default ACL que a instalação JÁ TEM — inclusive `anon`,
 * que é o que o dump da plataforma concede e o que a RLS + a varredura de anon do
 * baseline governam. O último caso compara o conjunto de privilégios de `anon` no
 * mundo de hoje com o do mundo pós-corte corrigido: tem de ser IGUAL. Se este
 * bloco um dia conceder mais do que o baseline concedia, é aqui que aparece.
 */

const RAIZ = process.cwd();
const DIR_MIGRATIONS = join(RAIZ, "supabase", "migrations");
const BASELINE = join(RAIZ, "supabase", "baseline.sql");

const ARQUIVO = readdirSync(DIR_MIGRATIONS).find((nome) => /^\d{14}_9029_[a-z0-9_]+\.sql$/.test(nome));
if (ARQUIVO === undefined) {
  throw new Error(
    "migration 9029 não encontrada em supabase/migrations/ — o número foi renumerado, " +
      "ou o arquivo que reescreve o default ACL de tabela saiu da cadeia.",
  );
}
const SQL_DA_MIGRATION = readFileSync(join(DIR_MIGRATIONS, ARQUIVO), "utf8");
const SQL_DO_BASELINE = readFileSync(BASELINE, "utf8");

const PRIVILEGIOS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const PAPEIS = ["anon", "authenticated", "service_role"] as const;
/** As quatro que a notificação da Supabase nomeia. */
const DA_DATA_API = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

const ANTES = "zz_prova_acl_9029_antes";
const DEPOIS_DO_CORTE = "zz_prova_acl_9029_depois_do_corte";
const DEPOIS_DO_BLOCO = "zz_prova_acl_9029_depois_do_bloco";

/** O apêndice do baseline: o complemento, tudo o que ele cria DEPOIS do dump. */
const APENDICE_FIM = "-- ---- VARREDURA anon:";
/** O apêndice começa no primeiro bloco do complemento — a mesma âncora da régua da issue. */
const APENDICE_INICIO = /^-- ---- /m;

function regiaoDoBaseline(inicio: RegExp | string, fim: string): string {
  const m = typeof inicio === "string" ? { index: SQL_DO_BASELINE.indexOf(inicio) } : APENDICE_INICIO.exec(SQL_DO_BASELINE);
  const de = m?.index ?? -1;
  if (de === -1) throw new Error(`marcador ausente no baseline.sql: '${String(inicio)}'.`);
  const ate = SQL_DO_BASELINE.indexOf(fim, de);
  if (ate === -1) throw new Error(`marcador ausente depois de '${String(inicio)}' no baseline.sql: '${fim}'.`);
  return SQL_DO_BASELINE.slice(de, ate);
}

/** SQL de verdade: sem as linhas de comentário — a prosa cita `create table` o tempo todo. */
function semComentario(sqlTexto: string): string {
  return sqlTexto
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("--"))
    .join("\n");
}

function tabelasCriadas(sqlTexto: string): string[] {
  const nomes = [
    ...semComentario(sqlTexto).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi),
  ]
    .map((m) => m[1])
    .filter((nome): nome is string => nome !== undefined)
    .map((nome) => nome.toLowerCase());
  return [...new Set(nomes)].sort();
}

function grantNomeiaTabela(sqlTexto: string, tabela: string): boolean {
  return new RegExp(`grant\\s+[^;]*\\bon\\s+(?:table\\s+)?public\\.${tabela}\\b`, "i").test(sqlTexto);
}

/**
 * As tabelas que o apêndice CRIA em `public` e que não têm `GRANT` próprio no
 * apêndice — a régua da issue, aplicada ao arquivo em vez de a um número digitado.
 * É nelas que a Data API depende do default ACL: a lista que a 9029 protege.
 */
function tabelasDoApendiceSemGrantProprio(): string[] {
  const apendice = semComentario(regiaoDoBaseline(APENDICE_INICIO, APENDICE_FIM));
  return tabelasCriadas(apendice).filter((tabela) => !grantNomeiaTabela(apendice, tabela));
}

function cria(tabela: string): void {
  sql(`
    drop table if exists public.${tabela};
    create table public.${tabela} (id integer not null, marca text);
  `);
}

function tem(role: string, tabela: string, priv: string): boolean {
  return sql(`select has_table_privilege('${role}', 'public.${tabela}', '${priv}');`) === "t";
}

function privilegiosDe(role: string, tabela: string): string[] {
  return PRIVILEGIOS.filter((p) => tem(role, tabela, p));
}

/** O que a plataforma vai fazer no provisionamento a partir de 30/10/2026. */
function cortaOQueASupabaseCorta(): void {
  sql(`
    alter default privileges for role postgres in schema public
      revoke all on tables from anon, authenticated, service_role;
  `);
}

/**
 * O bloco da 9029 como ele está NO BASELINE — do cabeçalho de apêndice até o
 * começo da varredura de anon, que é o bloco seguinte do arquivo.
 */
function blocoDoApendice(): string {
  const inicio = SQL_DO_BASELINE.search(/^-- ---- #3140: .*\(migration 9029\) ----$/m);
  if (inicio === -1) {
    throw new Error(
      "bloco da migration 9029 não encontrado no apêndice do baseline " +
        "('-- ---- #3140: … (migration 9029) ----'). Ele foi removido ou renomeado?",
    );
  }
  const fim = SQL_DO_BASELINE.indexOf(APENDICE_FIM, inicio);
  if (fim === -1) {
    throw new Error("marcador da varredura de anon ausente depois do bloco da 9029.");
  }
  return SQL_DO_BASELINE.slice(inicio, fim);
}

describe("tabela nova em public nasce concedida depois do corte de 30/10/2026 (9029)", () => {
  it("controle negativo: o corte MORDE — sem o bloco, tabela nova nasce muda", () => {
    // Mundo de hoje: o default ACL do Supabase concede os três roles.
    sql(blocoDoApendice());
    cria(ANTES);
    const hoje = privilegiosDe("authenticated", ANTES);
    expect(
      hoje,
      "no banco deste gate, tabela nova NÃO nasce com privilégio de authenticated — " +
        "sem isso o corte simulado abaixo não prova nada (o universo já seria o de 30/10).",
    ).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);

    cortaOQueASupabaseCorta();
    cria(DEPOIS_DO_CORTE);

    for (const papel of PAPEIS) {
      expect(
        privilegiosDe(papel, DEPOIS_DO_CORTE),
        `o corte simulado não tirou privilégio de ${papel} numa tabela criada depois dele — ` +
          "ou o revoke do default ACL não teve efeito, ou este banco não é o do produto.",
      ).toEqual([]);
    }

    // Devolve o banco ao estado do produto para os casos seguintes.
    sql(blocoDoApendice());
  });

  it("⭐ o ARQUIVO da migration devolve a tabela nova a authenticated e service_role, sem grant manual", () => {
    cortaOQueASupabaseCorta();
    // A migration roda DEPOIS do corte: é a ordem real da instalação nova.
    sql(SQL_DA_MIGRATION);

    cria(DEPOIS_DO_BLOCO);

    for (const papel of ["authenticated", "service_role"] as const) {
      for (const priv of DA_DATA_API) {
        expect(
          tem(papel, DEPOIS_DO_BLOCO, priv),
          `${papel} não tem ${priv} na tabela criada DEPOIS da migration 9029. ` +
            "É o 42501 que a Data API devolveria a partir de 30/10/2026.",
        ).toBe(true);

        // O privilégio NÃO veio de um `grant` escrito à mão: a migration não nomeia
        // tabela nenhuma (só reescreve o default ACL), e a tabela nem existia quando
        // ela rodou. O que se mede aqui é a procedência: a entrada da ACL é um grant
        // de PAPEL (`authenticated=…`), posto na criação — o formato que
        // `pg_default_acl` produz —, e não de `PUBLIC` nem de coluna.
        expect(
          Number(
            sql(`
              select count(*) from aclexplode(
                (select relacl from pg_class where oid = 'public.${DEPOIS_DO_BLOCO}'::regclass)
              ) a join pg_roles r on r.oid = a.grantee
               where r.rolname = '${papel}' and a.privilege_type = '${priv}';
            `),
          ),
          `${papel}:${priv} não aparece como grant de PAPEL na ACL da tabela nova — ` +
            "o privilégio não veio do default ACL que a 9029 reescreve.",
        ).toBe(1);
      }
    }

    // O outro lado da notificação: anon continua alcançável como hoje (é o que o
    // baseline concede) — medido em detalhe no último caso.
    expect(tem("anon", DEPOIS_DO_BLOCO, "SELECT")).toBe(true);
  });

  it("⭐ o BLOCO DO APÊNDICE (extraído do baseline) faz o mesmo trabalho", () => {
    cortaOQueASupabaseCorta();
    // Extraído do arquivo, não uma cópia: se o bloco sumir do baseline, isto quebra.
    sql(blocoDoApendice());

    cria(`${DEPOIS_DO_BLOCO}_pelo_baseline`);
    try {
      for (const priv of DA_DATA_API) {
        expect(
          tem("authenticated", `${DEPOIS_DO_BLOCO}_pelo_baseline`, priv),
          `o bloco do APÊNDICE do baseline não devolveu ${priv} a authenticated — ` +
            "o kit self-host aplica só o baseline, e a instalação dele quebraria com 42501.",
        ).toBe(true);
      }
    } finally {
      sql(`drop table if exists public.${DEPOIS_DO_BLOCO}_pelo_baseline;`);
    }
  });

  it("o apêndice é espelho VERBATIM da migration (CLI e kit recebem o mesmo SQL)", () => {
    expect(
      SQL_DO_BASELINE.includes(SQL_DA_MIGRATION),
      "o conteúdo da migration 9029 não aparece inteiro e idêntico no baseline.sql — " +
        "quem instala pelo kit receberia um produto diferente de quem aplica a cadeia.",
    ).toBe(true);
  });

  it("a lista de tabelas que dependem do default ACL sai do BASELINE, não de um literal", () => {
    const semGrantProprio = tabelasDoApendiceSemGrantProprio();

    // O tamanho do problema é medido, não digitado. Se a lista esvaziar, ou o apêndice
    // deixou de criar tabela sem `GRANT`, ou este parser deixou de achar o apêndice; as
    // duas hipóteses tiram o objeto da migration e merecem uma pessoa olhando.
    expect(
      semGrantProprio.length,
      "nenhuma tabela do apêndice sem GRANT próprio: o default ACL deixou de ser a " +
        "dependência que a 9029 cobre, ou o parser perdeu o apêndice do baseline.",
    ).toBeGreaterThan(0);

    // A lista é a régua, então ela tem de apontar para tabela de VERDADE. Parser que
    // lesse `create table` de prosa (o arquivo cita o comando em comentário) produziria
    // nome fantasma — e o caso passaria medindo nada.
    const amostra = [...semGrantProprio.slice(0, 5), ...semGrantProprio.slice(-5)];
    for (const tabela of amostra) {
      expect(
        sql(`select to_regclass('public.${tabela}') is not null;`),
        `${tabela} foi derivada do apêndice do baseline mas NÃO existe em public — ` +
          "o parser está lendo prosa, e a contagem acima não vale.",
      ).toBe("t");
      expect(
        tem("authenticated", tabela, "SELECT"),
        `${tabela} está no apêndice sem GRANT próprio e também não tem SELECT para ` +
          "authenticated no banco do gate — a premissa da migration (o default ACL é o " +
          "que a torna alcançável) não vale para ela.",
      ).toBe(true);
    }
  });

  it("anon ganha exatamente o que o baseline já concedia — nem um privilégio a mais", () => {
    // Régua: o mundo de hoje (default ACL do Supabase, o mesmo que este banco tem
    // antes de qualquer corte).
    sql(blocoDoApendice());
    cria(ANTES);
    const regua = privilegiosDe("anon", ANTES);
    expect(regua.length, "anon sem privilégio nenhum no mundo de hoje — a régua não mediu nada.").toBeGreaterThan(0);

    cortaOQueASupabaseCorta();
    sql(SQL_DA_MIGRATION);
    cria(`${DEPOIS_DO_BLOCO}_anon`);
    try {
      expect(
        privilegiosDe("anon", `${DEPOIS_DO_BLOCO}_anon`),
        "anon recebeu da 9029 um conjunto de privilégios DIFERENTE do que o baseline concede. " +
          "A migration restaura o default ACL; ampliar a superfície do anon é decisão de produto " +
          "(opção 2 da issue #3140), não efeito colateral de um conserto de prazo.",
      ).toEqual(regua);
    } finally {
      sql(`drop table if exists public.${DEPOIS_DO_BLOCO}_anon;`);
    }
  });
});
