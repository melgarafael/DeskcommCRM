import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import ts from "typescript";

// Mora na RAIZ, e não em tests/, porque vitest.config.ts o importa e o `next
// build` da imagem Docker typecheca todo `**/*.ts` do contexto — onde `tests/`
// não entra (.dockerignore). Em tests/ ele derrubou a imagem do app no #1190
// (TS2307), e só o gate `imagens-ok` viu.
//
// Quem é CERCA: o arquivo de teste que só importa builtin do Node, o próprio
// vitest, os parsers que as cercas usam — e módulo do próprio repositório
// (`@/`, caminho relativo) que, por sua vez, só importa isso, até o fim da
// cadeia. Ele lê arquivo do repositório (baseline, migrations, MANIFEST, docs,
// workflows, compose, dicionário de i18n, fragmentos de release…) e não toca
// DOM — por isso não precisa de jsdom, e a suíte inteira dele cabe em segundos.
//
// A regra transitiva existe desde 24/09/2026: `i18n-espanhol-cobre-a-tela` e
// `fragmentos-de-release` importam dados puros (`@/lib/i18n/*`,
// `@/lib/release/fragmento`), ficavam fora da seleção e reprovavam PR aos
// 5–6 min da suíte longa (#1604, #1587, #1598) em vez de no primeiro minuto.
//
// A lista é CALCULADA, nunca escrita à mão: uma lista fixa envelhece no primeiro
// teste estrutural novo, e ele voltaria a ser descoberto só no fim da suíte
// longa — que é exatamente o defeito que `pnpm cercas` existe para fechar.
// Qualquer import de pacote de terceiro fora da lista abaixo (react, testing
// library, supabase…) — direto ou por um módulo do repositório no meio do
// caminho — tira o arquivo da seleção; na dúvida ele fica no projeto `produto`
// (jsdom), que é só mais lento — cobertura nenhuma se perde. Os dois projetos
// estão em vitest.config.ts.
const MODULOS_DE_CERCA = new Set(["vitest", "typescript", "yaml", "zod"]);
const BUILTINS = new Set(["fs", "path", "child_process", "os", "url", "crypto", "util"]);

// Os mesmos diretórios que `vitest.config.ts` exclui (e os ocultos, que o glob
// do vitest também não visita), mais os que só têm teste
// de outra suíte (invariantes de banco, Playwright).
const FORA = new Set(["node_modules", "dist", "experiments"]);
const SUITES_DE_OUTRO_RUNNER = ["tests/e2e/", "tests/invariants/", "tests/journeys/"];
const EXTENSOES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
// O projeto `cercas` roda em `node`: sem `document`/`window`. Import nenhum
// denuncia o módulo que chama `document.execCommand` (lib/clipboard.ts), então
// quem cita um global do browser — no teste ou em qualquer módulo da cadeia,
// até em comentário — fica no `produto`, com jsdom.
const USA_DOM = /\b(?:document|window|navigator|localStorage|sessionStorage|HTMLElement)\b/;

function ehModuloDeCerca(especificador: string): boolean {
  if (especificador.startsWith("node:")) return true;
  return MODULOS_DE_CERCA.has(especificador) || BUILTINS.has(especificador);
}

// `moduloDoRepoEhCerca` responde pelos imports de `@/` e relativos; sem ele,
// qualquer import do repositório reprova (a regra direta, sem seguir a cadeia).
export function ehCerca(
  fonte: string,
  moduloDoRepoEhCerca: (especificador: string) => boolean = () => false,
): boolean {
  // O parser do TypeScript, e não uma regex: a regex casava `import … from
  // "@/lib/..."` escrito em COMENTÁRIO (tests/unit/helpers/chave-dinamica.ts) e
  // tirava da seleção o teste de i18n que motivou a regra transitiva.
  return ts
    .preProcessFile(fonte, true, true)
    .importedFiles.every(
      ({ fileName }) => ehModuloDeCerca(fileName) || moduloDoRepoEhCerca(fileName),
    );
}

function resolver(raiz: string, arquivo: string, especificador: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = join(raiz, especificador.slice(2));
  else if (especificador.startsWith(".")) base = join(dirname(arquivo), especificador);
  else return null;
  const candidato = EXTENSOES.map((ext) => base + ext).find(
    (c) => /\.tsx?$/.test(c) && existsSync(c) && statSync(c).isFile(),
  );
  return candidato ?? null;
}

// Memo por caminho absoluto. Ciclo conta como NÃO cerca (o valor provisório é
// `false`): conservador — no pior caso o teste fica no `produto`, mais lento.
function classificador(raiz: string): (arquivo: string) => boolean {
  const memo = new Map<string, boolean>();
  const classificar = (arquivo: string): boolean => {
    const conhecido = memo.get(arquivo);
    if (conhecido !== undefined) return conhecido;
    memo.set(arquivo, false);
    const fonte = readFileSync(arquivo, "utf-8");
    const resultado =
      !USA_DOM.test(fonte) &&
      ehCerca(fonte, (especificador) => {
        const alvo = resolver(raiz, arquivo, especificador);
        return alvo !== null && classificar(alvo);
      });
    memo.set(arquivo, resultado);
    return resultado;
  };
  return classificar;
}

function* arquivosDeTeste(raiz: string, dir: string): Generator<string> {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (FORA.has(entrada.name) || entrada.name.startsWith(".")) continue;
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) yield* arquivosDeTeste(raiz, caminho);
    else if (/\.test\.tsx?$/.test(entrada.name)) yield relative(raiz, caminho).replaceAll(sep, "/");
  }
}

function importa(fonte: string, modulos: string[]): boolean {
  return ts.preProcessFile(fonte, true, true).importedFiles.some(({ fileName }) =>
    modulos.includes(fileName),
  );
}

// A regra transitiva só vale para teste que LÊ o repositório (importa `fs`):
// é a guarda estrutural que reprova PR. Teste unitário de função pura que não
// lê arquivo nenhum segue no `produto` — mudá-lo de projeto não antecipa
// vermelho nenhum e só deslocaria tempo para a parte do `verify` que roda as
// cercas.
export function selecionarCercas(raiz: string): string[] {
  const classificar = classificador(raiz);
  return [...arquivosDeTeste(raiz, raiz)]
    .filter((f) => !SUITES_DE_OUTRO_RUNNER.some((p) => f.startsWith(p)))
    .filter((f) => {
      const fonte = readFileSync(join(raiz, f), "utf-8");
      if (ehCerca(fonte)) return true;
      return importa(fonte, ["fs", "node:fs"]) && classificar(join(raiz, f));
    })
    .sort();
}
