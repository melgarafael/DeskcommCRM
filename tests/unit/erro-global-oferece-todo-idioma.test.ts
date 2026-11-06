import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IDIOMAS } from "@/lib/i18n/idiomas";

/**
 * A página de erro global tem os botões de idioma escritos à mão: ela roda
 * quando o layout raiz caiu, sem provider e sem sessão, então não pode ler o
 * seletor normal. O compilador não aponta este arquivo quando um idioma é
 * promovido — este teste aponta.
 */
const FONTE = readFileSync(join(__dirname, "..", "..", "app", "global-error.tsx"), "utf8");

describe("a página de erro global", () => {
  it.each(IDIOMAS)("oferece o botão de %s", (codigo) => {
    expect(FONTE).toContain(`setIdioma("${codigo}")`);
  });
});
