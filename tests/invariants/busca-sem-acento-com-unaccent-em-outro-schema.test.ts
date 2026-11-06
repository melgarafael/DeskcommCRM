import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * A BUSCA SEM ACENTO SOBREVIVE À `unaccent` MORANDO EM OUTRO SCHEMA (migration 9100).
 *
 * O banco do `pnpm test:db` não tem `unaccent` antes do baseline, então o baseline
 * a cria em `public` e o invariante da 9098 (`busca-do-inbox-ignora-acento`) só
 * mede esse caso. O Supabase na nuvem liga extensões pelo painel em `extensions`,
 * e ali o `create extension if not exists` não faz nada. Medido com o bloco da
 * 9098 (`public.unaccent` fixo), num pg17 descartável:
 *
 *   - install com `contacts` vazia: rc=0, e TODO insert em `contacts` falha com
 *     `text search dictionary "public.unaccent" does not exist` — o `pg_dump`
 *     desliga `check_function_bodies`, então a função quebrada nasce calada;
 *   - update com `contacts` povoada: o `add column` falha e, sem `ON_ERROR_STOP`,
 *     a tabela fica sem `busca_sem_acento`.
 *
 * Aqui um banco PRÓPRIO recebe a extensão em `extensions` ANTES do baseline, e o
 * baseline é aplicado duas vezes (install, depois update). O que se cobra é o
 * comportamento — inserir um contato e achá-lo sem acento —, não a presença de
 * um símbolo no texto do SQL.
 */

const RAIZ = process.cwd();
const PRELUDE = readFileSync(join(RAIZ, "scripts", "selfhost-prelude.sql"), "utf8");
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

const BANCO = "inv_unaccent_em_extensions";
const ORG = "39180000-0000-4000-8000-0000000099aa";

afterAll(() => {
  sql(`drop database if exists ${BANCO} with (force);`);
});

/** Roda no banco próprio, com a saída das DDLs descartada. */
function noBanco(script: string): string {
  return sql([`\\c ${BANCO}`, "set client_min_messages = warning;", script].join("\n"));
}

function aplicarBaseline(): void {
  noBanco(["\\o /dev/null", BASELINE, "\\o"].join("\n"));
}

describe("busca sem acento com unaccent em outro schema", () => {
  it("install e update deixam a busca funcionando com a extensão em `extensions`", () => {
    sql(`drop database if exists ${BANCO} with (force);\ncreate database ${BANCO};`);
    noBanco(
      [
        "\\o /dev/null",
        PRELUDE,
        "create extension if not exists unaccent with schema extensions;",
        "\\o",
      ].join("\n"),
    );

    // Controle: o cenário é o que diz ser. Sem isto, um prelude que passasse a
    // criar `unaccent` em `public` deixaria este teste verde medindo o caso
    // que o invariante da 9098 já cobre.
    const schema = () =>
      noBanco(`select n.nspname from pg_extension e
                 join pg_namespace n on n.oid = e.extnamespace
                where e.extname = 'unaccent';`)
        .split("\n")
        .at(-1);
    expect(schema()).toBe("extensions");

    aplicarBaseline(); // install (o transporte roda com ON_ERROR_STOP=1)
    aplicarBaseline(); // update: reaplicar não pode recriar a função quebrada

    // A extensão NÃO foi movida — mover quebraria quem mais depende dela.
    expect(schema()).toBe("extensions");

    const linhas = noBanco(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'unaccent-em-extensions', 'x', 'x');
      insert into public.contacts (organization_id, display_name)
        values ('${ORG}', 'Andréia Souza');
      select 'f=' || public.f_unaccent('Andréia');
      select 'achou=' || count(*) from public.contacts
       where organization_id = '${ORG}' and busca_sem_acento ilike '%andreia%';
      select 'indice=' || count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'idx_contacts_busca_sem_acento_trgm';
    `).split("\n");

    expect(linhas).toContain("f=Andreia");
    expect(linhas).toContain("achou=1");
    expect(linhas).toContain("indice=1");
  }, 300_000);
});
