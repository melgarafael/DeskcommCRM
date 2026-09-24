/**
 * TODA ORIGEM QUE O CÓDIGO GRAVA EM `org_memory_entries.source` CABE NO CHECK.
 *
 * Diagnóstico de @vgamkt no #1130: a ferramenta MCP `crm_save_org_memory`
 * (lib/mcp/tools/evolucao.ts) gravava `source: "agent"`, e o CHECK inline da
 * 0067 só aceitava `manual` e `flywheel`. Toda chamada falhava com 23514 — e
 * nenhum gate do `verify` via, porque o compilador não enxerga o banco e o
 * invariante de vocabulário (que enxerga) roda só no `test:db`, e esta coluna
 * nem estava nele. A 0385 amplia o CHECK; este arquivo é a catraca barata,
 * estática, que roda no `verify`.
 *
 * Os gravadores são DESCOBERTOS por varredura (`.from("org_memory_entries")`
 * seguido de `.insert`/`.upsert`), não listados à mão: um gravador novo entra na
 * conta no dia em que é escrito.
 *
 * NÃO MEDIDO aqui: o banco de verdade — este arquivo lê o TEXTO do baseline.
 * A coluna ainda NÃO é par de tests/invariants/vocabulario-banco-x-typescript
 * (o pre-commit congela `tests/invariants/**`); acrescentá-la lá é o passo que
 * leva esta comparação ao Postgres aplicado.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** O conjunto do CHECK na ÚLTIMA definição nomeada do baseline — a que o banco instala. */
function valoresDoCheckNoBaseline(): string[] {
  const sql = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  const definicoes = [
    ...sql.matchAll(
      /add\s+constraint\s+org_memory_entries_source_check\s+check\s*\(\s*source\s+in\s*\(([^)]*)\)\s*\)/gi,
    ),
  ];
  const ultima = definicoes.at(-1);
  if (!ultima) {
    throw new Error(
      "não achei `add constraint org_memory_entries_source_check check (source in (...))` no " +
        "baseline.sql — se a forma mudou, ensine esta sonda; lista vazia aprovaria por vacuidade.",
    );
  }
  return [...ultima[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
}

function arquivosDeCodigo(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome.startsWith(".")) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivosDeCodigo(caminho));
    else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

/** `source: "x"` de todo insert/upsert em `org_memory_entries`, com o arquivo de onde veio. */
function origensGravadas(): Array<{ arquivo: string; valor: string }> {
  const achados: Array<{ arquivo: string; valor: string }> = [];
  for (const raiz of ["lib", "app", "workers", "scripts"]) {
    for (const arquivo of arquivosDeCodigo(join(RAIZ, raiz))) {
      const fonte = readFileSync(arquivo, "utf8");
      for (const m of fonte.matchAll(
        /\.from\(\s*["']org_memory_entries["']\s*\)\s*\.(?:insert|upsert)\(\s*\{([\s\S]*?)\}\s*\)/g,
      )) {
        for (const s of m[1]!.matchAll(/\bsource:\s*["']([^"']+)["']/g)) {
          achados.push({ arquivo: arquivo.slice(RAIZ.length + 1), valor: s[1]! });
        }
      }
    }
  }
  return achados;
}

describe("org_memory_entries.source — o que o código grava cabe no CHECK", () => {
  it("a ferramenta MCP grava 'agent' e o CHECK do baseline aceita", () => {
    const gravadas = origensGravadas();
    // Controle positivo: os três gravadores conhecidos têm de ser achados. Sem
    // isto, um regex quebrado devolveria zero achados e o teste abaixo passaria.
    expect(gravadas).toEqual(
      expect.arrayContaining([
        { arquivo: "lib/mcp/tools/evolucao.ts", valor: "agent" },
        { arquivo: "lib/ai/apply-proposal.ts", valor: "flywheel" },
        { arquivo: "app/api/v1/ai/memory/entries/route.ts", valor: "manual" },
      ]),
    );

    const aceitas = new Set(valoresDoCheckNoBaseline());
    const recusadas = gravadas.filter((g) => !aceitas.has(g.valor));
    expect(
      recusadas,
      "estes INSERTs falhariam com 23514 — amplie o CHECK com migration + apêndice do baseline",
    ).toEqual([]);
  });

  it("o tipo da tela fala o mesmo vocabulário do CHECK", () => {
    const fonte = readFileSync(join(RAIZ, "hooks", "ai", "useOrgMemory.ts"), "utf8");
    const decl = /type\s+OrigemDaMemoria\s*=([^;]*);/.exec(fonte);
    expect(decl, "não achei `type OrigemDaMemoria = ...;` em hooks/ai/useOrgMemory.ts").not.toBeNull();
    const doTipo = [...decl![1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!).sort();
    expect(doTipo).toEqual(valoresDoCheckNoBaseline());
  });
});
