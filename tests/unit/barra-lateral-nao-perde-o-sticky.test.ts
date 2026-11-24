/** Cerca estrutural: a prova geométrica do sticky exige um navegador. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const raiz = join(__dirname, "..", "..");
const ler = (arquivo: string) => readFileSync(join(raiz, arquivo), "utf8");
const css = ler("app/globals.css");

describe("a rede contra scroll horizontal não pode matar o sticky", () => {
  for (const seletor of ["html", "body"]) {
    it(`${seletor} permite que o Radix trave a rolagem da janela`, () => {
      const inicio = css.indexOf(`\n  ${seletor} {`);
      expect(inicio).toBeGreaterThan(-1);
      const bloco = css.slice(inicio, css.indexOf("\n  }", inicio));
      expect(bloco).not.toMatch(/overflow(?:-x|-y)?:\s*(hidden|clip|auto|scroll)\s*;/);
    });
  }

  for (const arquivo of ["app/app/_components/AppShell.tsx", "components/admin/AdminShell.tsx"]) {
    it(`${arquivo} contém o recorte horizontal na casca`, () => {
      expect(ler(arquivo)).toMatch(/className="flex min-h-[^"\n]*\boverflow-x-clip\b/);
    });
  }

  it("o layout raiz não recoloca o recorte em html ou body", () => {
    expect(ler("app/layout.tsx")).not.toMatch(/<(?:html|body)\b[^>]*overflow-x-(?:clip|hidden)/);
  });

  it("a barra lateral continua sticky", () => {
    const sidebar = ler("components/shell/Sidebar.tsx");
    expect(sidebar).toContain('"sticky top-[var(--faixas-de-cima,0px)] ');
    expect(sidebar).not.toMatch(/className=\{?[^}]*"fixed /);
  });
});
