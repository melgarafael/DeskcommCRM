/**
 * Todo `insert` em `event_log` escrito à mão informa `entity_kind`.
 *
 * O defeito que originou esta cerca, medido no log do CI em 14/09/2026:
 *
 *   [ai_agents/publish] event_log error
 *   null value in column "entity_kind" of relation "event_log" violates not-null constraint
 *
 * Os dois `insert` de `ai_agent.published` em `app/app/ai/agents/[id]/_actions.ts`
 * omitiam a coluna. `entity_kind` é NOT NULL **sem default**, então o evento de
 * publicação de agente NUNCA foi gravado — em toda instalação, desde sempre.
 *
 * Por que ninguém viu: o insert é `void` + `.then()`, e a violação cai num
 * `console.error` que ninguém lê. É o invariante 3 do Sistema Vivo (log
 * universal e visível) falhando em silêncio — o pior desfecho, porque o sistema
 * parece estar registrando.
 *
 * Por que a cerca é por ARQUIVO-FONTE e não por execução: o dublê de Supabase
 * dos testes de unidade não tem constraint, então um insert sem `entity_kind`
 * passa verde nele. Quem reprovaria é um Postgres real — e nenhum invariante
 * exercita estas duas server actions. Enquanto não exercitar, a leitura do
 * fonte é a única sonda que existe, e ela é honesta sobre o que mede: presença
 * da coluna no insert, não o efeito no banco.
 *
 * A `emit_event()` do baseline recebe `p_entity_kind` como argumento
 * obrigatório, então quem a usa está coberto pelo próprio contrato. Esta cerca
 * existe para quem escreve o `insert` à mão.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** Arquivos versionados que fazem `.from("event_log").insert(` à mão. */
function arquivosComInsertDireto(): string[] {
  const todos = execFileSync("git", ["ls-files", "app", "lib", "workers", "hooks", "components"], {
    cwd: RAIZ,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f));

  return todos.filter((f) => {
    const fonte = readFileSync(join(RAIZ, f), "utf8");
    return /\.from\(\s*["'`]event_log["'`]\s*\)[\s\S]{0,200}?\.insert\(/.test(fonte);
  });
}

describe("evento gravado à mão declara o próprio dono", () => {
  it("existe pelo menos um insert direto em event_log — senão esta cerca não mede nada", () => {
    // Controle de vacuidade: sem ele, um regex quebrado devolve lista vazia e o
    // teste abaixo passa afirmando que está tudo certo.
    expect(arquivosComInsertDireto().length).toBeGreaterThan(0);
  });

  it("todo insert direto em event_log informa entity_kind", () => {
    const faltando: string[] = [];

    for (const arquivo of arquivosComInsertDireto()) {
      const fonte = readFileSync(join(RAIZ, arquivo), "utf8");
      const inserts = fonte.matchAll(
        /\.from\(\s*["'`]event_log["'`]\s*\)[\s\S]{0,200}?\.insert\(\s*(\{[\s\S]*?\n\s*\})\s*\)/g,
      );
      for (const achado of inserts) {
        const corpo = achado[1]!;
        if (!/\bentity_kind\s*:/.test(corpo)) {
          const linha = fonte.slice(0, achado.index).split("\n").length;
          faltando.push(`${arquivo}:${linha}`);
        }
      }
    }

    expect(
      faltando,
      "`event_log.entity_kind` é NOT NULL sem default: o insert viola a constraint e o evento " +
        "nunca é gravado. Como o insert costuma ser `void` + `.then()`, o erro morre num " +
        "console.error e o sistema parece estar registrando.",
    ).toEqual([]);
  });
});
