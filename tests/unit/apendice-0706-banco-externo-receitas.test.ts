/**
 * O APÊNDICE DO BASELINE É ESPELHO EXATO DA MIGRATION 0706 — cerca, não prosa.
 *
 * O kit self-host aplica só o `baseline.sql`; a migration é a fonte da verdade
 * para quem usa o Supabase CLI. Divergência entre os dois significa que o clone
 * recebe uma versão diferente da que o repositório diz entregar.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261022120000_0706_banco_externo_receitas.sql";

describe("o apêndice do baseline espelha a migration 0706 (receitas do banco externo)", () => {
  it("controle: os dois arquivos existem e não estão vazios", () => {
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
    expect(migration.length).toBeGreaterThan(1000);
    expect(baseline.length).toBeGreaterThan(1000);
  });

  it("⭐ o conteúdo da migration aparece no baseline, sem uma única diferença", () => {
    const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

    if (!baseline.includes(migration)) {
      const linhas = migration.split("\n");
      const divergente = linhas.findIndex((l) => l.trim().length > 0 && !baseline.includes(l));
      throw new Error(
        divergente === -1
          ? "O baseline não contém a migration inteira, mas toda linha dela existe nele isolada: " +
            "o apêndice provavelmente está fora de ordem ou cortado."
          : `O apêndice do baseline divergiu da migration a partir da linha ${divergente + 1}:\n` +
            `  ${linhas[divergente]}\n` +
            "Refaça o apêndice a partir do baseline da main (git checkout origin/main -- " +
            "supabase/baseline.sql) e reaplique o delta. Não edite o baseline à mão.",
      );
    }
    expect(baseline.includes(migration)).toBe(true);
  });

  it("a migration tem cabeçalho `-- manifest:` com descrição não vazia", () => {
    const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
    const manifest = /^-- manifest:[ \t]*(\S.*)$/m.exec(migration);
    expect(manifest, "a migration 0706 precisa de uma linha `-- manifest: <o quê e por quê>` no cabeçalho").not.toBeNull();
    expect(manifest![1]!.trim().length).toBeGreaterThan(0);
  });
});
