/**
 * Toda spec e2e importa de `tests/e2e/helpers/test.ts`, não de `@playwright/test`.
 *
 * O `test` de lá faz `page.goto`/`page.reload` esperarem o streaming SSR revelar
 * a página (issue #1374). Uma spec que importa direto do Playwright volta a ler
 * o documento no meio da revelação e a achar duas cópias de cada testid — e
 * reprova de forma intermitente em PR que nem toca a tela dela.
 *
 * `import type` e `import("@playwright/test").Page` continuam livres: tipo não
 * navega.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ_E2E = join(__dirname, "../e2e");
const IMPORT_DE_VALOR = /^import\s+(?!type\b)[^;]*?from\s+["']@playwright\/test["']/m;

function specs(): string[] {
  return readdirSync(RAIZ_E2E, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".spec.ts"));
}

describe("specs e2e usam o test da suíte (issue #1374)", () => {
  it("a sonda enxerga o import proibido e deixa passar o de tipo", () => {
    expect(IMPORT_DE_VALOR.test('import { test, expect } from "@playwright/test";')).toBe(true);
    expect(IMPORT_DE_VALOR.test('import {\n  test,\n  expect,\n} from "@playwright/test";')).toBe(true);
    expect(IMPORT_DE_VALOR.test('import type { Page } from "@playwright/test";')).toBe(false);
    expect(IMPORT_DE_VALOR.test('import { test, expect } from "./helpers/test";')).toBe(false);
  });

  it("nenhuma spec importa valor de @playwright/test", () => {
    const lista = specs();
    expect(lista.length).toBeGreaterThan(0);
    const fora = lista.filter((f) => IMPORT_DE_VALOR.test(readFileSync(join(RAIZ_E2E, f), "utf8")));
    expect(fora, "importe de './helpers/test' — ele espera a revelação do streaming SSR").toEqual([]);
  });
});
