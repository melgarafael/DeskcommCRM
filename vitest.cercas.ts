import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Mora na RAIZ, e não em tests/, porque vitest.config.ts o importa e o `next
// build` da imagem Docker typecheca todo `**/*.ts` do contexto — onde `tests/`
// não entra (.dockerignore). Em tests/ ele derrubou a imagem do app no #1190
// (TS2307), e só o gate `imagens-ok` viu.
//
// Quem é CERCA: o arquivo de teste que só importa builtin do Node, o próprio
// vitest e os dois parsers que as cercas usam. Ele lê arquivo do repositório
// (baseline, migrations, MANIFEST, docs, workflows, compose…) e não executa
// código do produto — por isso não precisa de jsdom nem do `.env`, e a suíte
// inteira dele cabe em segundos.
//
// A lista é CALCULADA, nunca escrita à mão: uma lista fixa envelhece no primeiro
// teste estrutural novo, e ele voltaria a ser descoberto só no fim da suíte
// longa — que é exatamente o defeito que `pnpm cercas` existe para fechar.
// Qualquer import de `@/`, de caminho relativo ou de pacote de terceiro tira o
// arquivo da seleção; na dúvida ele fica no projeto `produto` (jsdom), que é
// só mais lento — cobertura nenhuma se perde. Os dois projetos estão em
// vitest.config.ts.
const MODULOS_DE_CERCA = new Set(["vitest", "typescript", "yaml"]);
const BUILTINS = new Set(["fs", "path", "child_process", "os", "url", "crypto", "util"]);

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|(?:require|import)\(\s*['"]([^'"]+)['"]/g;

// Os mesmos diretórios que `vitest.config.ts` exclui (e os ocultos, que o glob
// do vitest também não visita), mais os que só têm teste
// de outra suíte (invariantes de banco, Playwright).
const FORA = new Set(["node_modules", "dist", "experiments"]);
const SUITES_DE_OUTRO_RUNNER = ["tests/e2e/", "tests/invariants/", "tests/journeys/"];

function ehModuloDeCerca(especificador: string): boolean {
  if (especificador.startsWith("node:")) return true;
  return MODULOS_DE_CERCA.has(especificador) || BUILTINS.has(especificador);
}

export function ehCerca(fonte: string): boolean {
  for (const m of fonte.matchAll(IMPORT)) {
    const especificador = m[1] ?? m[2] ?? m[3];
    if (especificador && !ehModuloDeCerca(especificador)) return false;
  }
  return true;
}

function* arquivosDeTeste(raiz: string, dir: string): Generator<string> {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (FORA.has(entrada.name) || entrada.name.startsWith(".")) continue;
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) yield* arquivosDeTeste(raiz, caminho);
    else if (/\.test\.tsx?$/.test(entrada.name)) yield relative(raiz, caminho).replaceAll(sep, "/");
  }
}

export function selecionarCercas(raiz: string): string[] {
  return [...arquivosDeTeste(raiz, raiz)]
    .filter((f) => !SUITES_DE_OUTRO_RUNNER.some((p) => f.startsWith(p)))
    .filter((f) => ehCerca(readFileSync(join(raiz, f), "utf-8")))
    .sort();
}
