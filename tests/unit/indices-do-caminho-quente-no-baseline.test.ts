import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * OS ÍNDICES DA 0585 CHEGAM A QUEM SÓ APLICA O BASELINE.
 *
 * O self-host recebe schema pelo `baseline.sql`, nunca pela cadeia. Índice que
 * mora só na migration não existe na VPS. O invariante
 * `tests/invariants/indices-do-caminho-quente.test.ts` prova, no banco, que os
 * índices existem e servem as consultas; este teste roda sem banco e acusa no
 * PR o apêndice esquecido ou divergente da migration.
 */
const RAIZ = join(process.cwd(), "supabase");
const MIGRATION = readFileSync(
  join(RAIZ, "migrations", "20261007131321_0585_indices_do_caminho_quente.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(RAIZ, "baseline.sql"), "utf8");

function criacoesDeIndice(sql: string): string[] {
  const semComentario = sql.replace(/--.*$/gm, "");
  return (semComentario.match(/create index if not exists[^;]*;/gi) ?? []).map((s) =>
    s.replace(/\s+/g, " ").trim(),
  );
}

describe("migration 0585 no baseline", () => {
  const daMigration = criacoesDeIndice(MIGRATION);
  const doBaseline = new Set(criacoesDeIndice(BASELINE));

  it("a migration cria os cinco índices", () => {
    expect(daMigration).toHaveLength(5);
  });

  it.each(daMigration)("o baseline traz %s", (criacao) => {
    expect(doBaseline.has(criacao)).toBe(true);
  });
});
