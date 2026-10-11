import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Um arquivo de ENTRADA do App Router sem "use client" (page, layout, route…)
 * roda no servidor. Se ele importa de um módulo "use client" algo que não é
 * componente — uma constante, uma função —, o que chega é uma referência de
 * cliente, não o valor: `ABAS_DA_COBRANCA.find is not a function` derrubou
 * /admin/cobranca inteira (PR 3a da cobrança). Nem o tsc nem o vitest veem a
 * fronteira; só o e2e via, e tarde. Componente (PascalCase) atravessa: é o uso
 * previsto. Hook importado aqui também é erro (hook não roda no servidor).
 *
 * O recorte são só os arquivos de entrada porque são os únicos que SEMPRE são
 * servidor: um módulo sem diretiva importado só por cliente pode usar hook à vontade.
 */

const RAIZ = path.resolve(__dirname, "../..");
const ENTRADA = /^(page|layout|template|default|not-found|route)\.tsx?$/;
const DIRETIVA_CLIENTE = /^\s*(\/\/[^\n]*\n\s*)*["']use client["']/;

function ehCliente(arquivo: string): boolean {
  return DIRETIVA_CLIENTE.test(readFileSync(arquivo, "utf8").slice(0, 400));
}

function resolver(origem: string, especificador: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = path.join(RAIZ, especificador.slice(2));
  else if (especificador.startsWith(".")) base = path.resolve(path.dirname(origem), especificador);
  else return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const c = base + ext;
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Valores (não componentes, não tipos) importados de módulo cliente por este fonte de servidor. */
function valoresDeCliente(origem: string, fonte: string): string[] {
  const achados: string[] = [];
  for (const m of fonte.matchAll(/import\s+\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    const alvo = resolver(origem, m[2]!);
    if (!alvo || !ehCliente(alvo)) continue;
    for (const bruto of m[1]!.split(",")) {
      const nome = bruto.trim().split(/\s+as\s+/)[0]!;
      if (!nome || nome.startsWith("type ") || /^[A-Z][a-z0-9]/.test(nome)) continue;
      achados.push(`${nome} ← ${path.relative(RAIZ, alvo)}`);
    }
  }
  return achados;
}

function entradas(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return entradas(p);
    return ENTRADA.test(e.name) ? [p] : [];
  });
}

describe("arquivo de servidor do App Router não importa valor de módulo \"use client\"", () => {
  it("nenhuma page/layout/route de servidor importa constante, função ou hook de módulo cliente", () => {
    const todas = entradas(path.join(RAIZ, "app"));
    expect(todas.length).toBeGreaterThan(100);
    const violacoes = todas
      .filter((p) => !ehCliente(p))
      .flatMap((p) => valoresDeCliente(p, readFileSync(p, "utf8")).map((v) => `${path.relative(RAIZ, p)}: ${v}`));
    expect(violacoes).toEqual([]);
  });

  it("controle: a forma que quebrou /admin/cobranca é acusada; componente e tipo passam", () => {
    const origem = path.join(RAIZ, "app/admin/(protected)/cobranca/page.tsx");
    expect(valoresDeCliente(origem, 'import { ABAS_DA_COBRANCA, AbasDaCobranca, type AbaDaCobranca } from "./_abas";')).toEqual([
      "ABAS_DA_COBRANCA ← app/admin/(protected)/cobranca/_abas.tsx",
    ]);
    expect(valoresDeCliente(origem, 'import { AbasDaCobranca } from "./_abas";')).toEqual([]);
  });
});
