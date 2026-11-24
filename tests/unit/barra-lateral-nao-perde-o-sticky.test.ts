/** Cerca estrutural: a prova geométrica do sticky exige um navegador. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const raiz = join(__dirname, "..", "..");
const ler = (arquivo: string) => readFileSync(join(raiz, arquivo), "utf8");
const css = ler("app/globals.css");

const bloco = (seletor: string): string => {
  const inicio = css.indexOf(`\n  ${seletor} {`);
  expect(inicio).toBeGreaterThan(-1);
  return css.slice(inicio, css.indexOf("\n  }", inicio));
};

describe("a rede contra scroll horizontal não pode matar o sticky", () => {
  it("html fica sem overflow, para o do body passar à janela e o Radix travar sem salto", () => {
    expect(bloco("html")).not.toMatch(/overflow(?:-x|-y)?:\s*(hidden|clip|auto|scroll)\s*;/);
  });

  it("body mantém a rede contra rolagem lateral, com clip depois de hidden", () => {
    expect(bloco("body")).toMatch(/overflow-x:\s*hidden;\s*overflow-x:\s*clip;/);
  });

  for (const arquivo of ["app/app/_components/AppShell.tsx", "components/admin/AdminShell.tsx"]) {
    it(`${arquivo} contém o recorte horizontal na casca`, () => {
      expect(ler(arquivo)).toMatch(/className="flex min-h-[^"\n]*\boverflow-x-clip\b/);
    });
  }

  it("o layout raiz corta a rolagem lateral num div em volta das páginas", () => {
    expect(ler("app/layout.tsx")).toMatch(
      /<div className="overflow-x-clip">\s*<MarcaDosClientComponents>\s*<ThemeProvider>\{children\}<\/ThemeProvider>\s*<\/MarcaDosClientComponents>\s*<\/div>/,
    );
  });

  it("o layout raiz não recoloca o recorte em html ou body", () => {
    expect(ler("app/layout.tsx")).not.toMatch(/<(?:html|body)\b[^>]*overflow-x-(?:clip|hidden)/);
  });

  it("a barra lateral continua sticky", () => {
    const sidebar = ler("components/shell/Sidebar.tsx");
    expect(sidebar).toContain('"sticky top-[var(--faixas-de-cima,0px)] ');
    expect(sidebar).not.toMatch(/className=\{?[^}]*"fixed /);
  });
});
