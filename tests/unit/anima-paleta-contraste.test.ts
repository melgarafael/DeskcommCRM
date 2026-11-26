/**
 * Fork Ânima — os pisos de contraste da PALETA ÂNIMA, como ela está no `app/globals.css`.
 *
 * Os testes de calibração do upstream (`branding-*.test.ts`) passaram a medir a Sage congelada em
 * `tests/fixtures/anima/` (ver `regua-sage.ts`). Este arquivo devolve à paleta do produto as
 * guardas que importam para quem usa o Ânima Hub:
 *  - o produto sem marca cabe nos pisos WCAG, nos dois temas;
 *  - qualquer marca de runtime (as 16 sementes adversariais do upstream) continua cabendo;
 *  - a identidade do DS está onde foi decidida (limão no escuro, verde legível no claro);
 *  - o `globals.css` está em dia com o pacote `@anima-solutions/design-system` instalado.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PISOS,
  derivarMarca,
  extrairRegua,
  medirPares,
  razaoDeContraste,
} from "@/lib/branding/contraste";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";

const RAIZ = process.cwd();
const CSS = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");
const REGUA = extrairRegua(CSS);

/** A mesma fixture adversarial de `tests/unit/branding-contraste.test.ts`. */
const FIXTURE = [
  "#0f172a",
  "#f5c518",
  "#ffffff",
  "#000000",
  "#808080",
  "#dc2626",
  "#22c55e",
  "#f59e0b",
  "#2563eb",
  "#14b8a6",
  "#4b0082",
  "#e11d48",
  "#7c3aed",
  "#1a1f36",
  "#fafafa",
  "#506d48",
] as const;

const exigirDs = (arquivo: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(RAIZ, "node_modules/@anima-solutions/design-system/dist/tokens", arquivo),
      "utf8",
    ),
  );

function valorDoBloco(seletor: string, prop: string): string {
  const inicio = CSS.indexOf(`\n${seletor} {\n`);
  const fim = CSS.indexOf("\n}\n", inicio);
  const m = new RegExp(`^\\s*${prop}:\\s*([^;]+);`, "m").exec(CSS.slice(inicio, fim));
  if (!m?.[1]) throw new Error(`${prop} ausente em ${seletor}`);
  return m[1].trim();
}

function resolver(seletor: string, prop: string): string {
  const v = valorDoBloco(seletor, prop);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (!ref) return v;
  // os graus da escala moram no :root (claro) e são repetidos no bloco escuro
  return valorDoBloco(seletor === '[data-theme="dark"]' ? seletor : ":root", ref[1]!);
}

describe("paleta Ânima — pisos de contraste", () => {
  it("a régua congelada é a do globals.css de hoje", () => {
    expect(REGUA_DO_PRODUTO).toEqual(REGUA);
  });

  it("o produto sem marca cabe nos pisos, nos dois temas (guarda de vacuidade incluída)", () => {
    for (const tema of [REGUA.claro, REGUA.escuro]) {
      const pares = medirPares(tema, REGUA.rampaDoProduto, 0);
      expect(pares.length, `${tema.nome}: nenhum par medido`).toBeGreaterThanOrEqual(18);
      const reprovas = pares.filter((p) => !p.passa);
      expect(reprovas, `${tema.nome}: ${JSON.stringify(reprovas)}`).toEqual([]);
    }
  });

  it("toda marca de runtime da fixture adversarial cabe nos pisos sobre a base Ânima", () => {
    for (const semente of FIXTURE) {
      const marca = derivarMarca(semente, REGUA);
      for (const tema of [marca.claro, marca.escuro]) {
        expect(tema.pares.length, `${semente}: nenhum par medido`).toBeGreaterThanOrEqual(18);
        const reprovas = tema.pares.filter((p) => !p.passa);
        expect(
          reprovas,
          `${semente} · grau ${tema.grauDoAccent}: ` +
            reprovas.map((r) => `${r.papel}×${r.superficie}=${r.razao.toFixed(2)}`).join(", "),
        ).toEqual([]);
      }
    }
  });
});

describe("paleta Ânima — identidade do DS", () => {
  const limao = (exigirDs("base.json").color["brand-primary"].$value as { hex: string }).hex;

  it("no escuro, o destaque é o limão do DS, com o texto que o DS põe sobre ele", () => {
    expect(resolver('[data-theme="dark"]', "--color-accent").toLowerCase()).toBe(
      limao.toLowerCase(),
    );
    expect(valorDoBloco('[data-theme="dark"]', "--color-accent-fg")).toBe("#11141b");
  });

  it("no claro, o destaque NÃO é o limão (ilegível) e o texto sobre ele passa 4,5:1", () => {
    const accent = resolver(":root", "--color-accent");
    expect(accent.toLowerCase()).not.toBe(limao.toLowerCase());
    expect(razaoDeContraste(limao, valorDoBloco(":root", "--color-bg"))).toBeLessThan(
      PISOS.componente,
    );
    const fg = valorDoBloco(":root", "--color-accent-fg");
    expect(razaoDeContraste(fg, accent)).toBeGreaterThanOrEqual(PISOS.texto);
  });

  it("raios aprovados: botões e campos 12px, cards e diálogos 28px", () => {
    expect(valorDoBloco(":root", "--radius-sm")).toBe("12px");
    expect(valorDoBloco(":root", "--radius-lg")).toBe("28px");
  });

  it("o globals.css está em dia com o pacote do DS instalado", () => {
    // Pega o pacote atualizado sem rodar o gerador (ou o globals.css editado à mão).
    const tsx = path.join(RAIZ, "node_modules/.bin/tsx");
    const saida = execFileSync(tsx, ["scripts/anima/gerar-tokens-ds.ts", "--conferir"], {
      cwd: RAIZ,
      encoding: "utf8",
    });
    expect(saida).toMatch(/em dia/);
  }, 60_000);
});
