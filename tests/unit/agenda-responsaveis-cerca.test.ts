import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TETO_ADICIONAIS } from "@/lib/agenda/responsaveis";

/**
 * CERCA: o teto de adicionais na migration é o mesmo que o código TS declara.
 * Se alguém mudar um e esquecer o outro, este teste fica vermelho.
 */
describe("cerca do teto de responsáveis", () => {
  it("o número 9 aparece uma vez no SQL da migration, igual a TETO_ADICIONAIS", () => {
    const migration = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "supabase",
        "migrations",
        "20261126114644_9494_responsaveis_da_consulta.sql",
      ),
      "utf8",
    );
    // A constante legível no SQL: `limite constant integer := 9;`
    const match = migration.match(/limite constant integer := (\d+);/);
    expect(match).not.toBeNull();
    const tetoSQL = Number(match![1]);
    expect(tetoSQL).toBe(TETO_ADICIONAIS);
    expect(TETO_ADICIONAIS).toBe(9);
  });
});
