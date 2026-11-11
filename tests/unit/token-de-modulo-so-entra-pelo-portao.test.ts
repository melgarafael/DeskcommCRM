/**
 * CERCA: o token de módulo só entra pelo portão (Spec 33, F3, tarefa 3).
 *
 * Todo `dsk_` é autenticado por `validateBearerToken` / `resolveApiToken` (`lib/mcp/auth.ts`).
 * Só TRÊS arquivos de produção podem chamá-los:
 *
 *  - `lib/api/auth-dual.ts`: confere a ÁREA do módulo (`autorizarModulo`) antes do papel;
 *  - `app/api/mcp/route.ts` e `app/api/v1/contacts/route.ts`: recusam o ator `module`.
 *
 * Um quarto chamador seria uma entrada que aceita o token de módulo (`mcp:read`) e lê pelos
 * escopos, sem passar pela área consentida. Esta cerca varre o repositório e quebra quando
 * ele aparecer, e confere que os três arquivos previstos têm a guarda.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

const PERMITIDOS = [
  "lib/mcp/auth.ts", // onde as funções moram
  "lib/api/auth-dual.ts",
  "app/api/mcp/route.ts",
  "app/api/v1/contacts/route.ts",
];

const PASTAS_IGNORADAS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  ".worktrees",
  "coverage",
  "dist",
  "build",
  "evidence",
  "playwright-report",
  "test-results",
]);

function arquivos(pasta: string, saida: string[] = []): string[] {
  for (const d of readdirSync(pasta, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (!PASTAS_IGNORADAS.has(d.name)) arquivos(join(pasta, d.name), saida);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(d.name)) {
      saida.push(join(pasta, d.name));
    }
  }
  return saida;
}

const ehTeste = (rel: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.startsWith("tests/") || rel.includes("/__tests__/");

/** Linhas de código, sem comentário de linha nem de bloco (a menção em texto não conta). */
function codigoSemComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
}

const CHAMA = /\b(validateBearerToken|resolveApiToken)\b/;

function chamadoresDeProducao(): string[] {
  return arquivos(RAIZ)
    .map((f) => relative(RAIZ, f).split(sep).join("/"))
    .filter((rel) => !ehTeste(rel))
    .filter((rel) => CHAMA.test(codigoSemComentarios(readFileSync(join(RAIZ, rel), "utf8"))))
    .sort();
}

describe("token de módulo só entra pelo portão", () => {
  it("só os arquivos previstos chamam validateBearerToken / resolveApiToken", () => {
    expect(chamadoresDeProducao()).toEqual([...PERMITIDOS].sort());
  });

  it("auth-dual.ts confere a área do módulo antes do papel e do escopo", () => {
    const texto = readFileSync(join(RAIZ, "lib/api/auth-dual.ts"), "utf8");
    const area = texto.indexOf("autorizarModulo(");
    const escopo = texto.indexOf("ensureScope(auth.scopes");
    expect(area).toBeGreaterThan(-1);
    expect(texto).toMatch(/auth\.actor\.type === "module"/);
    expect(area).toBeLessThan(escopo);
  });

  it.each(["app/api/mcp/route.ts", "app/api/v1/contacts/route.ts"])(
    "%s recusa o ator `module` logo depois de validar o token",
    (rel) => {
      const texto = readFileSync(join(RAIZ, rel), "utf8");
      const validar = texto.search(/await validateBearerToken\(/);
      const recusa = texto.search(/actor\.type === "module"/);
      expect(validar).toBeGreaterThan(-1);
      expect(recusa).toBeGreaterThan(validar);
      expect(texto).toContain("MODULO_NAO_ENTRA_AQUI");
    },
  );

  it("o próprio varredor enxerga um chamador novo (a cerca não é cega)", () => {
    expect(CHAMA.test(codigoSemComentarios("await validateBearerToken(h);"))).toBe(true);
    expect(CHAMA.test(codigoSemComentarios("// validateBearerToken(h)\n/* resolveApiToken */"))).toBe(
      false,
    );
    expect(ehTeste("lib/novo/entrada.ts")).toBe(false);
    expect(ehTeste("lib/novo/entrada.test.ts")).toBe(true);
  });
});
