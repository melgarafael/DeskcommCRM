import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * NENHUMA TABELA FAZ O POSTGREST VER `user_organizations` <-> `organizations`
 * COMO MUITOS-PARA-MUITOS (#3219).
 *
 * O PostgREST trata como junção toda tabela cujas FKs têm as colunas dentro da
 * PK. Quando a mesma PK cobre uma FK para `organizations` E uma FK para
 * `user_organizations`, nasce uma relação falsa entre as duas, e todo embed
 * `user_organizations?select=organizations(...)` sem nome de FK passa a
 * responder 300 PGRST201. Foi o que a 0716 fez em `calendar_service_professionals`
 * e a 0717 desfez.
 *
 * O teste de presença em `tests/unit/` só lê texto: ele fica verde mesmo se
 * alguém voltar a adicionar a FK direta. Este mede o catálogo do banco que o
 * baseline produziu.
 *
 * Fora do escopo: a ambiguidade `organizations` <-> `calendar_event_types`, via
 * `calendar_service_resources` e `calendar_service_calendar_sources`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(query: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: query, encoding: "utf8" },
  ).trim();
}

function tabelasCujaPkCobreFkPara(alvo: string): string[] {
  const saida = sql(`
    select distinct pk.conrelid::regclass::text
      from pg_constraint pk
      join pg_constraint fk on fk.conrelid = pk.conrelid
                           and fk.contype = 'f'
                           and fk.confrelid = '${alvo}'::regclass
                           and fk.conkey <@ pk.conkey
     where pk.contype = 'p'
       and pk.connamespace = 'public'::regnamespace
     order by 1;
  `);
  return saida ? saida.split("\n") : [];
}

describe("junção falsa user_organizations <-> organizations", () => {
  it("a sonda enxerga a tabela que liga membro a serviço (guarda contra instrumento morto)", () => {
    expect(tabelasCujaPkCobreFkPara("public.user_organizations")).toContain(
      "calendar_service_professionals",
    );
  });

  it("nenhuma PK de public cobre ao mesmo tempo FK para organizations e para user_organizations", () => {
    const paraMembro = new Set(tabelasCujaPkCobreFkPara("public.user_organizations"));
    const ambas = tabelasCujaPkCobreFkPara("public.organizations").filter((t) => paraMembro.has(t));
    expect(ambas).toEqual([]);
  });
});
