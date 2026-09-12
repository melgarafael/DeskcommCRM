import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * NENHUM `useState` DECIDE O PRIMEIRO RENDER LENDO O NAVEGADOR.
 *
 * ─── A classe, e a segunda instância viva (issue #690) ──────────────────────
 *
 * O inicializador de `useState` roda de novo na HIDRATAÇÃO — que é a primeira
 * renderização do cliente, a mesma que o React compara contra o HTML que o
 * servidor mandou. Uma função que decide a fonte por `typeof window ===
 * "undefined"` devolve o padrão no servidor e o valor real no cliente, e a
 * diferença aparece nessa comparação como hydration mismatch.
 *
 * O PR #666 consertou a instância do seletor de tema (`lib/theme.tsx`) e a
 * deixou viva em `app/app/settings/notifications/_client.tsx`, que inicializava
 * com `useState<NotifyPrefs>(() => lerPrefs())`. Não é hipótese: `lerPrefs()`
 * alcança `window.localStorage` dois níveis abaixo, em `prefsPadrao()`, então
 * o valor vai para dez `Switch` e para o `data-testid` que
 * `canalLigado("message", "push")` alimentava durante o render.
 *
 * ─── Por que a sonda segue chamada, e não só olha a expressão ───────────────
 *
 * Uma sonda que só procurasse `window` DENTRO do inicializador não pegaria o
 * defeito real: ali dentro só existe `lerPrefs()`. O texto da issue é explícito
 * — *"nenhuma guarda reprova useState que lê o navegador no inicializador"* — e
 * o que lê o navegador é a função CHAMADA. Por isso esta sonda resolve o
 * identificador: função local do mesmo arquivo, ou `import` de um módulo do
 * repositório, seguido transitivamente (com conjunto de visitados, para ciclo
 * não travar a suíte).
 *
 * ─── O que ela NÃO é ────────────────────────────────────────────────────────
 *
 * Ela não julga `new Date()` nem qualquer outra fonte de não-determinismo: a
 * classe aqui é "lê o navegador", e alargar isso para "qualquer coisa que mude
 * entre servidor e cliente" reprovaria meia dúzia de relógios de tela que já
 * existem e não são este defeito.
 *
 * Controles nas duas direções, no fim do arquivo: `hooks/ai/useDebugToggle.ts`
 * é o padrão CORRETO (inicializador determinístico, leitura no `useEffect`) e
 * precisa passar; um inicializador que chama `lerPrefs` precisa reprovar.
 */
const RAIZ = join(__dirname, "..", "..");
const DIRS = ["app", "components", "lib", "hooks"];

/**
 * Globais que só existem no navegador. Uma leitura a qualquer um deles no
 * caminho do inicializador é a classe do defeito.
 */
const GLOBAIS_DO_NAVEGADOR = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "history",
  "screen",
  "matchMedia",
  "Notification",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IntersectionObserver",
  "ResizeObserver",
  "MutationObserver",
  "indexedDB",
  "caches",
  "customElements",
  "visualViewport",
]);

/** Caminhos relativos à raiz, em POSIX — a identidade do módulo neste arquivo. */
export function arquivosVigiados(): string[] {
  const saida: string[] = [];
  const descer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = posix.join(dir, e.name);
      if (e.isDirectory()) descer(rel);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) saida.push(rel);
    }
  };
  for (const d of DIRS) descer(d);
  return saida.sort();
}

export function fontesDoRepositorio(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const rel of arquivosVigiados()) mapa.set(rel, readFileSync(join(RAIZ, rel), "utf8"));
  return mapa;
}

/** `@/lib/x` e `./x` viram o caminho relativo à raiz, ou `null` se for pacote. */
function resolverModulo(especificador: string, deArquivo: string, fontes: Map<string, string>): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = especificador.slice(2);
  else if (especificador.startsWith(".")) base = posix.join(posix.dirname(deArquivo), especificador);
  else return null;
  for (const sufixo of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (fontes.has(base + sufixo)) return base + sufixo;
  }
  return null;
}

type Indice = {
  funcoes: Map<string, Map<string, ts.Node>>;
  imports: Map<string, Map<string, string>>;
};

/**
 * O arquivo sob varredura pode não estar no mapa — os controles abaixo passam
 * uma fonte de fixture. Sem esta camada, `useState(() => ler())` com `ler` no
 * MESMO arquivo não resolveria, e o controle positivo passaria com a sonda
 * quebrada, que é o pior resultado possível para uma guarda.
 */
type Busca = {
  funcoes: (arquivo: string) => Map<string, ts.Node> | undefined;
  imports: (arquivo: string) => Map<string, string> | undefined;
};

const cacheDeIndice = new WeakMap<Map<string, string>, Indice>();

function funcoesDoArquivo(sf: ts.SourceFile): Map<string, ts.Node> {
  const mapa = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      mapa.set(st.name.text, st);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
          mapa.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return mapa;
}

function importsDoArquivo(sf: ts.SourceFile, fontes: Map<string, string>): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    // `import x = require("y")` também é ImportDeclaration, e ali o
    // `moduleSpecifier` não é literal de string.
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const alvo = resolverModulo(st.moduleSpecifier.text, sf.fileName, fontes);
    if (!alvo) continue;
    const cl = st.importClause;
    if (cl.name) mapa.set(cl.name.text, alvo);
    if (cl.namedBindings && ts.isNamedImports(cl.namedBindings)) {
      for (const el of cl.namedBindings.elements) mapa.set(el.name.text, alvo);
    }
  }
  return mapa;
}

function indice(fontes: Map<string, string>): Indice {
  const existente = cacheDeIndice.get(fontes);
  if (existente) return existente;
  const fns = new Map<string, Map<string, ts.Node>>();
  const imp = new Map<string, Map<string, string>>();
  for (const [rel, fonte] of fontes) {
    // `fileName` é o caminho relativo POSIX de propósito: é a chave de
    // resolução de `./x` e `@/x`, e mantém a sonda igual em Windows e Linux.
    const arquivo = ts.createSourceFile(rel, fonte, ts.ScriptTarget.Latest, true);
    fns.set(rel, funcoesDoArquivo(arquivo));
    imp.set(rel, importsDoArquivo(arquivo, fontes));
  }
  const novo = { funcoes: fns, imports: imp };
  cacheDeIndice.set(fontes, novo);
  return novo;
}

/** O índice do repositório, com o arquivo sob varredura por cima. */
function buscaCom(fontes: Map<string, string>, nomeDoArquivo: string, fonte: string): Busca {
  const idx = indice(fontes);
  const arquivo = ts.createSourceFile(nomeDoArquivo, fonte, ts.ScriptTarget.Latest, true);
  const fns = funcoesDoArquivo(arquivo);
  const imp = importsDoArquivo(arquivo, fontes);
  return {
    funcoes: (rel) => (rel === nomeDoArquivo ? fns : idx.funcoes.get(rel)),
    imports: (rel) => (rel === nomeDoArquivo ? imp : idx.imports.get(rel)),
  };
}

/**
 * Nomes de globais do navegador alcançáveis a partir de `no`, seguindo
 * chamadas a funções locais e a funções importadas de módulos do repositório.
 */
function globaisAlcancados(no: ts.Node, busca: Busca, arquivo: string, visitados: Set<string>): Set<string> {
  const achados = new Set<string>();
  const visitar = (n: ts.Node, deArquivo: string): void => {
    if (ts.isIdentifier(n)) {
      if (GLOBAIS_DO_NAVEGADOR.has(n.text)) {
        achados.add(n.text);
        return;
      }
      const local = busca.funcoes(deArquivo)?.get(n.text);
      if (local) {
        const chave = `${deArquivo}#${n.text}`;
        if (!visitados.has(chave)) {
          visitados.add(chave);
          visitar(local, deArquivo);
        }
        return;
      }
      const alvo = busca.imports(deArquivo)?.get(n.text);
      if (alvo) {
        const chave = `${alvo}#${n.text}`;
        if (!visitados.has(chave)) {
          visitados.add(chave);
          const fn = busca.funcoes(alvo)?.get(n.text);
          if (fn) visitar(fn, alvo);
        }
      }
      return;
    }
    ts.forEachChild(n, (filho) => visitar(filho, deArquivo));
  };
  visitar(no, arquivo);
  return achados;
}

/**
 * Linhas (1-based) das chamadas a `useState` cujo inicializador — o primeiro
 * argumento, quando é função — alcança um global do navegador.
 *
 * Ancorado no AST e não em regex: a prosa deste repositório cita `useState` e
 * `window` o tempo todo, inclusive nos comentários que explicam este defeito, e
 * um regex reprovaria o arquivo por ele falar de si mesmo.
 */
export function inicializadoresQueLeemONavegador(
  fonte: string,
  nomeDoArquivo: string,
  fontes: Map<string, string>,
): number[] {
  const busca = buscaCom(fontes, nomeDoArquivo, fonte);
  const arquivo = ts.createSourceFile(nomeDoArquivo, fonte, ts.ScriptTarget.Latest, true);
  const infratoras: number[] = [];

  const visita = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const ehUseState =
        (ts.isIdentifier(e) && e.text === "useState") ||
        (ts.isPropertyAccessExpression(e) && e.name.text === "useState");
      const a0 = n.arguments[0];
      if (ehUseState && a0 && (ts.isArrowFunction(a0) || ts.isFunctionExpression(a0))) {
        if (globaisAlcancados(a0, busca, nomeDoArquivo, new Set()).size > 0) {
          infratoras.push(arquivo.getLineAndCharacterOfPosition(n.getStart(arquivo)).line + 1);
        }
      }
    }
    ts.forEachChild(n, visita);
  };
  visita(arquivo);
  return infratoras;
}

describe("o inicializador de useState não lê o navegador", () => {
  const fontes = fontesDoRepositorio();

  it("GUARDA DE VACUIDADE: a varredura alcança o repositório de verdade", () => {
    // Sem este caso, um caminho errado devolveria zero arquivos e a suíte
    // inteira passaria por não ter olhado nada.
    expect(arquivosVigiados().length).toBeGreaterThan(1000);
    expect(fontes.has("app/app/settings/notifications/_client.tsx")).toBe(true);
    expect(fontes.has("lib/notifications/prefs.ts")).toBe(true);
  });

  it("nenhum arquivo de `app|components|lib|hooks` tem inicializador que lê o navegador", () => {
    const violacoes: string[] = [];
    for (const [rel, fonte] of fontes) {
      for (const linha of inicializadoresQueLeemONavegador(fonte, rel, fontes)) {
        violacoes.push(`${rel}:${linha}`);
      }
    }
    expect(
      violacoes,
      "Inicializador de `useState` que lê o navegador: ele roda de novo na " +
        "hidratação, com `window` de verdade, e o cliente diverge do HTML que " +
        "o servidor mandou. Use `useSyncExternalStore` com um " +
        "`getServerSnapshot` determinístico — ver `lib/theme.tsx`.",
    ).toEqual([]);
  });

  it("CONTROLE POSITIVO: a sonda reprova o padrão do defeito, inclusive através de um import", () => {
    // `lerPrefs()` mora em outro módulo e só lá dentro toca `window`. Se a
    // sonda não seguisse o import, este caso passaria — e o defeito real
    // (issue #690) teria passado com ele.
    const fonte = [
      '"use client";',
      'import { useState } from "react";',
      'import { lerPrefs } from "@/lib/notifications/prefs";',
      "export function C() {",
      "  const [prefs] = useState(() => lerPrefs());",
      "  return prefs.message.in_app;",
      "}",
    ].join("\n");
    expect(inicializadoresQueLeemONavegador(fonte, "app/fixture.tsx", fontes)).toEqual([5]);
  });

  it("CONTROLE NEGATIVO: o padrão correto do repositório passa", () => {
    // `hooks/ai/useDebugToggle.ts` é o controle que a própria issue cita:
    // inicializador determinístico (`defaultFor(role)`), leitura do navegador
    // dentro do `useEffect`. Também serve de guarda contra a sonda alargar
    // para "qualquer função chamada" e reprovar o repositório inteiro.
    const rel = "hooks/ai/useDebugToggle.ts";
    expect(inicializadoresQueLeemONavegador(fontes.get(rel)!, rel, fontes)).toEqual([]);
  });

  it("CONTROLE POSITIVO LOCAL: uma função auxiliar do mesmo arquivo também reprova", () => {
    const fonte = [
      'import { useState } from "react";',
      "function ler() {",
      "  return window.localStorage.getItem('x');",
      "}",
      "export function C() {",
      "  const [v] = useState(() => ler());",
      "  return v;",
      "}",
    ].join("\n");
    expect(inicializadoresQueLeemONavegador(fonte, "app/fixture.tsx", fontes)).toEqual([6]);
  });

  it("CONTROLE NEGATIVO do relógio: `new Date()` NÃO é desta classe", () => {
    // Deliberadamente fora do escopo: meia dúzia de telas inicializa um
    // relógio assim, e nenhuma delas é o defeito do `window`.
    const fonte = [
      'import { useState } from "react";',
      "export function C() {",
      "  const [agora] = useState(() => new Date());",
      "  return agora.toISOString();",
      "}",
    ].join("\n");
    expect(inicializadoresQueLeemONavegador(fonte, "app/fixture.tsx", fontes)).toEqual([]);
  });
});
