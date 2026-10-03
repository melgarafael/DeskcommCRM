import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * `scripts/selfhost-prelude.sql` + `supabase/baseline.sql` APLICAM num Postgres vazio.
 *
 * O prelude é o caminho "Postgres próprio" do guia do self-host: ele cria os
 * stubs do Supabase que o dump supõe. O gate de CI tem o SEU prelude, dentro de
 * `scripts/test-db.sh`, e os dois só andavam juntos por um comentário ("se
 * editar um, edite o outro"). Não andaram: o de CI ganhou
 * `auth.users.raw_user_meta_data` (0202), `auth.sessions`, `auth.mfa_factors` e
 * `auth.jwt()`, o do self-host não, e o baseline parava no backfill de
 * `conversations.assigned_to_user_name` — com o gate verde.
 *
 * Aqui o arquivo que o operador aplica é aplicado de verdade, num banco próprio,
 * com `ON_ERROR_STOP=1` (o transporte já roda assim), seguido do baseline.
 */

const RAIZ = process.cwd();
const PRELUDE = readFileSync(join(RAIZ, "scripts", "selfhost-prelude.sql"), "utf8");
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

const BANCO = "inv_selfhost_prelude";
const FIM = "SELFHOST-BASELINE-APLICADO";

afterAll(() => {
  sql(`drop database if exists ${BANCO} with (force);`);
});

describe("prelude do self-host", () => {
  it("prelude + baseline aplicam com ON_ERROR_STOP num Postgres vazio", () => {
    sql(`drop database if exists ${BANCO} with (force);\ncreate database ${BANCO};`);
    // `\o /dev/null`: as milhares de linhas de "CREATE TABLE"/"ALTER…" não
    // interessam; a prova é a marca final, que só sai se nada parou antes.
    const saida = sql(
      [
        `\\c ${BANCO}`,
        "set client_min_messages = warning;",
        "\\o /dev/null",
        PRELUDE,
        BASELINE,
        "\\o",
        `select '${FIM}';`,
      ].join("\n"),
    );
    expect(
      saida.split("\n").at(-1),
      "o baseline não chegou ao fim depois do prelude do self-host",
    ).toBe(FIM);
  }, 180_000);
});
