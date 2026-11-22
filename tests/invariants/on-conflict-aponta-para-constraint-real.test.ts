import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { provisionadorasDoCatalogo } from "./molde-de-provisionadora";

/**
 * TODO `onConflict` APONTA PARA UMA CONSTRAINT QUE EXISTE.
 *
 * ## O defeito que este arquivo existe para pegar
 *
 * `ingestConversationsBatch` gravava trechos com
 * `onConflict: "organization_id,kb_version_id,content_hash"`. Essa constraint
 * NUNCA existiu — a de `ai_chunks` é `ai_chunks_position_unique`
 * `(knowledge_source_id, kb_version_id, position)`. O Postgres responde
 *
 *     there is no unique or exclusion constraint matching the ON CONFLICT specification
 *
 * e o `upsert` falha. Cada falha era um `console.warn` num laço, o retorno era
 * ignorado, e a conversa era marcada como aproveitada assim mesmo — o acervo de
 * conversas anonimizadas nunca teve um único trecho, e as conversas marcadas
 * saíram da fila para sempre.
 *
 * O caminho de PRODUTO tinha o mesmo alvo errado e foi corrigido antes; o de
 * conversas ficou. Um alvo errado é indistinguível de um certo à leitura — é
 * uma string, e nenhum tipo a valida. Por isso a guarda é aqui, contra o banco.
 *
 * ## Por que a varredura é do REPO inteiro
 *
 * Consertar a instância deixaria a classe viva: qualquer `upsert` novo pode
 * nascer com o alvo errado e falhar em silêncio no primeiro conflito real — que
 * costuma acontecer em produção, não no teste. A varredura acha todos.
 *
 * O alvo é aceito quando as colunas nomeadas formam EXATAMENTE o conjunto de
 * uma constraint única (ou de um índice único) da tabela. `ON CONFLICT` do
 * Postgres casa por conjunto de colunas, não por nome, e é essa a regra
 * reproduzida aqui.
 */

const RAIZ = process.cwd();

/** `.upsert(<algo>, { onConflict: "a,b" })` — a tabela vem do `.from("x")` acima. */
interface Uso {
  arquivo: string;
  tabela: string;
  colunas: string[];
}

function arquivosDoRepo(): string[] {
  return execFileSync("git", ["ls-files", "lib", "app", "workers", "scripts"], {
    encoding: "utf8",
    cwd: RAIZ,
  })
    .split("\n")
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
}

/**
 * Acha o `.from("<tabela>")` mais próximo ACIMA do `onConflict`.
 *
 * Heurística, e ela precisa ser honesta sobre o que não alcança: quando não há
 * `.from()` antes na mesma janela, o uso é REPORTADO como não-resolvido em vez
 * de silenciosamente ignorado — varredura que pula o que não entende devolve
 * "nenhum problema" com a mesma cara de "está tudo certo".
 *
 * O `as <tipo>` é opcional no padrão porque o repo escreve `.from("x" as never)`
 * para tabela que ainda não está em `lib/database.types.ts` — sem ele, o
 * `push_subscriptions` do Web Push era reportado como não-resolvido, e o alvo
 * dele (`endpoint`, que É único) nunca chegava a ser conferido contra o banco.
 * A string continua tendo de ser LITERAL: `.from(variavel)` segue não-resolvido,
 * porque uma tabela que só se conhece em runtime não tem como ser conferida aqui.
 */
function usosDe(arquivo: string): { usos: Uso[]; naoResolvidos: string[] } {
  const texto = readFileSync(join(RAIZ, arquivo), "utf8");
  const usos: Uso[] = [];
  const naoResolvidos: string[] = [];

  const re = /onConflict:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const antes = texto.slice(0, m.index);
    const from = [...antes.matchAll(/\.from\(\s*"([a-z0-9_]+)"(?:\s+as\s+\w+)?\s*\)/g)].pop();
    const colunas = (m[1] ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (!from) {
      naoResolvidos.push(`${arquivo}: onConflict "${m[1]}" sem .from() antes`);
      continue;
    }
    usos.push({ arquivo, tabela: from[1] as string, colunas });
  }
  return { usos, naoResolvidos };
}

/** Conjuntos de colunas que o Postgres aceita em `ON CONFLICT` para a tabela. */
function conjuntosUnicos(tabela: string): string[][] {
  const out = sql(`
    select string_agg(a.attname, ',' order by a.attname)
      from pg_class t
      join pg_index i on i.indrelid = t.oid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = any(i.indkey)
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = '${tabela}'
       and i.indisunique
     group by i.indexrelid;
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(",").map((c) => c.trim()).sort());
}

/**
 * O banco de cada arquivo nasce sem módulo instalado, e a tabela de um módulo de
 * tabela (ADR-0002) só existe depois da provisionadora dele. Sem provisionar, o
 * `upsert` de um módulo como o `amigo` lia "nenhum índice único" numa tabela que
 * simplesmente ainda não existia, e a régua não conferia o alvo de verdade.
 */
beforeAll(() => {
  for (const p of provisionadorasDoCatalogo()) sql(`select public.${p.nome}();`);
});

describe("onConflict × constraints reais", () => {
  const arquivos = arquivosDoRepo();
  const todos = arquivos.map(usosDe);
  const usos = todos.flatMap((t) => t.usos);
  const naoResolvidos = todos.flatMap((t) => t.naoResolvidos);

  it("a varredura ENXERGA usos — controle positivo", () => {
    // Sem isto, um regex quebrado devolveria zero usos e o caso abaixo passaria
    // por não medir nada. O número é um PISO, não uma contagem: ele não
    // envelhece quando alguém acrescenta um upsert.
    expect(usos.length, "a varredura não achou nenhum onConflict — instrumento quebrado").toBeGreaterThan(10);
  });

  it("todo onConflict resolve a tabela dele", () => {
    expect(naoResolvidos, "usos que a varredura não soube atribuir a uma tabela").toEqual([]);
  });

  it("todo onConflict casa com uma constraint única que existe no banco", () => {
    const quebrados: string[] = [];

    for (const uso of usos) {
      const conjuntos = conjuntosUnicos(uso.tabela);
      if (conjuntos.length === 0) {
        quebrados.push(`${uso.arquivo}: tabela "${uso.tabela}" não tem NENHUM índice único`);
        continue;
      }
      const alvo = [...uso.colunas].sort();
      const casa = conjuntos.some(
        (c) => c.length === alvo.length && c.every((col, i) => col === alvo[i]),
      );
      if (!casa) {
        quebrados.push(
          `${uso.arquivo}: ON CONFLICT (${uso.colunas.join(", ")}) em "${uso.tabela}" — ` +
            `únicos disponíveis: ${conjuntos.map((c) => `(${c.join(", ")})`).join(" | ")}`,
        );
      }
    }

    expect(
      quebrados,
      "\nUm ON CONFLICT sem constraint correspondente NÃO é erro de compilação:\n" +
        "o Postgres recusa a instrução e o upsert falha no primeiro conflito real,\n" +
        "que costuma acontecer em produção. Foi assim que a ingestão de conversas\n" +
        "gravou ZERO trechos por meses.\n" +
        `${quebrados.join("\n")}\n`,
    ).toEqual([]);
  });

  it("CONTROLE: um alvo inventado é reprovado pelo mesmo instrumento", () => {
    // Sem esta metade, "nenhum quebrado" passaria com `conjuntosUnicos`
    // devolvendo lixo, ou com a comparação sempre verdadeira.
    const conjuntos = conjuntosUnicos("ai_chunks");
    const inventado = ["organization_id", "kb_version_id", "content_hash"].sort();
    const casa = conjuntos.some(
      (c) => c.length === inventado.length && c.every((col, i) => col === inventado[i]),
    );
    expect(casa, "o alvo que a ingestão de conversas usava passou como válido").toBe(false);
  });
});
