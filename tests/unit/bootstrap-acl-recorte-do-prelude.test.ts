import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const script = readFileSync(path.join(RAIZ, "scripts/test-update-com-dados.sh"), "utf8");
const linha = script.split("\n").find((texto) => texto.startsWith("prelude=$("));
if (linha === undefined) throw new Error("a extração do prelude não foi encontrada");

/** Executa o recorte REAL, sem entrar no script que sobe banco ou aplica SQL. */
function extrairPrelude(): string {
  return execFileSync(
    "bash",
    ["-c", "set -euo pipefail\nROOT=$1\n" + linha + "\nprintf '%s' \"$prelude\"", "_", RAIZ],
    { encoding: "utf8" },
  );
}

describe("o update extrai só o prelude, mesmo com recibos SQL posteriores", () => {
  it("a extração preserva extensões e as três famílias reais do bootstrap", () => {
    const prelude = extrairPrelude();
    expect(prelude).toContain("create extension");
    expect(prelude).toContain("create schema if not exists auth");
    for (const familia of ["functions", "tables", "sequences"]) {
      expect(prelude).toMatch(new RegExp("alter default privileges .* on " + familia + " "));
    }
  });

  it("os blocos posteriores de captura/remoção não entram como prelude", () => {
    const fonte = readFileSync(path.join(RAIZ, "scripts/test-db.sh"), "utf8");
    expect(fonte).toContain("create table test_db.acl_do_bootstrap");
    expect(fonte).toContain("set sondas_removidas_antes_do_baseline");
    const prelude = extrairPrelude();
    expect(prelude).not.toContain("test_db.acl_do_bootstrap");
    expect(prelude).not.toContain("sondas_removidas_antes_do_baseline");
    expect(prelude).not.toContain("psql_install <<");
    expect(prelude.split("\n")).not.toContain("SQL");
  });
});
