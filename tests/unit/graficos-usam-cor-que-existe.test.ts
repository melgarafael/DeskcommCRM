import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `hsl(var(--token))` sem fallback não pinta nada neste repositório.
 *
 * Nenhum token do `app/globals.css` guarda um trio HSL (`142 76% 36%`): os de
 * cor são hex ou apelidos de `--color-*` (`--border: var(--color-border)`), e
 * `--accent` nem existe. `hsl()` recusa hex e recusa token ausente, o valor
 * inteiro fica inválido e o navegador cai no padrão — medido no Chrome, o
 * `stroke` computado de `hsl(var(--accent))` é `none`. A linha do gráfico de
 * uso, a do Desempenho (#3262) e a borda dos tooltips sumiam assim, com build
 * e testes verdes, porque o recharts recebe a string como atributo e ninguém a
 * confere. A cor certa é o token direto: `var(--color-accent)`, que ainda segue
 * a marca do revendedor.
 *
 * Com fallback (`hsl(var(--chart-2, 142 76% 36%))`) o valor é válido: o token
 * ausente cai no trio escrito ao lado.
 */
const RAIZ = process.cwd();
const PASTAS = ["app", "components", "hooks", "lib"];
const SEM_FALLBACK = /hsl\(var\(--[a-z0-9-]+\)\)/g;

function fontes(): string[] {
  return PASTAS.flatMap((pasta) =>
    (fs.readdirSync(path.join(RAIZ, pasta), { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => path.join(pasta, f)),
  );
}

describe("cor de gráfico aponta para token que pinta", () => {
  it("nenhum `hsl(var(--token))` sem fallback no código de produção", () => {
    const achados = fontes().flatMap((arquivo) => {
      const texto = fs.readFileSync(path.join(RAIZ, arquivo), "utf8");
      return [...texto.matchAll(SEM_FALLBACK)].map((m) => `${arquivo}: ${m[0]}`);
    });
    expect(achados).toEqual([]);
  });

  it("a sonda enxerga o padrão que ela proíbe (controle positivo)", () => {
    expect('stroke="hsl(var(--accent))"'.match(SEM_FALLBACK)).toHaveLength(1);
    expect('stopColor="hsl(var(--chart-2,142 76% 36%))"'.match(SEM_FALLBACK)).toBeNull();
  });
});
