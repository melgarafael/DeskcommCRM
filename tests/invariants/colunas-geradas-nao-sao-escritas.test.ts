import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * NINGUÉM ESCREVE EM COLUNA GERADA.
 *
 * ═══ POR QUE ISTO É UM GATE, E NÃO TRÊS CONSERTOS ═══
 *
 * O Postgres recusa qualquer atribuição a uma coluna `GENERATED ALWAYS ...
 * STORED` (SQLSTATE 428C9) e **aborta a instrução inteira**. Não é um campo que
 * se perde: é o INSERT/UPDATE todo que morre, levando junto os campos que nada
 * têm a ver com a coluna gerada.
 *
 * O padrão já tinha sido corrigido uma vez, num caminho. Em 2026-08-06 havia
 * **três instâncias vivas**, todas provadas contra Postgres real:
 *
 * | onde | o que quebrava |
 * |---|---|
 * | `app/api/v1/contacts/_handler.ts` | salvar o e-mail de um contato pela tela → 500 |
 * | `app/api/v1/lgpd/anonymize/route.ts` | **a anonimização LGPD não acontecia** |
 * | `lib/waha/ingest.ts` | fim do warm-up abortava o UPDATE e o `status` do canal congelava |
 *
 * Consertar as três deixaria a quarta nascer amanhã sem nada vermelhar — a
 * lição é "conserto por classe, não por instância". Este teste varre TODAS as
 * colunas geradas que o schema tiver, hoje e no futuro: coluna gerada nova
 * entra na varredura sozinha, sem ninguém lembrar de acrescentá-la.
 *
 * ═══ POR QUE INVARIANTE DE BANCO ═══
 *
 * A lista de colunas geradas é PERGUNTADA ao Postgres, não escrita à mão. Uma
 * lista fixa envelheceria em silêncio — que é exatamente o modo de falha que
 * este arquivo existe para impedir.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

/** Onde código de produção pode escrever no banco. `tests/` fica de fora de propósito. */
const RAIZES = ["app", "lib", "scripts"];

/**
 * Dívida CONGELADA. Vazia — as três instâncias conhecidas foram corrigidas no
 * mesmo commit que criou este gate, de propósito: gate que nasce vermelho é
 * gate que alguém desliga. Se precisar acrescentar uma linha aqui, escreva o
 * porquê ao lado; sem justificativa, o caminho é consertar.
 */
const DIVIDA_ACEITA: ReadonlyArray<{ arquivo: string; coluna: string; porque: string }> = [
  {
    arquivo: "app/api/v1/attendant-schedule/route.ts",
    coluna: "ends_at",
    porque:
      "Falso positivo: a varredura casa por NOME de coluna, sem saber a tabela. Esta escrita é em " +
      "attendant_schedule.ends_at (coluna `time`, comum, com CHECK ends_at > starts_at) — não tem " +
      "relação com appointments.ends_at (a coluna GERADA que este gate protege). Mesmo nome, tabelas " +
      "e colunas diferentes; a escrita aqui é legítima e obrigatória (é o próprio campo que a rota " +
      "PUT /api/v1/attendant-schedule existe para gravar).",
  },
];

interface ColunaGerada {
  tabela: string;
  coluna: string;
  expressao: string;
}

async function colunasGeradas(): Promise<ColunaGerada[]> {
  const { rows } = await pool.query<{ table_name: string; column_name: string; generation_expression: string }>(
    `select table_name, column_name, generation_expression
       from information_schema.columns
      where table_schema = 'public' and is_generated = 'ALWAYS'
      order by table_name, column_name`,
  );
  return rows.map((r) => ({
    tabela: r.table_name,
    coluna: r.column_name,
    expressao: r.generation_expression,
  }));
}

/** Arquivos de código de produção, via git (respeita .gitignore sozinho). */
function arquivosDeProducao(): string[] {
  const saida = execFileSync("git", ["ls-files", ...RAIZES], { encoding: "utf8" });
  return saida
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => !f.endsWith("lib/database.types.ts")); // tipos gerados: declara, não escreve
}

/**
 * Uma ESCRITA NO BANCO — não uma menção, não uma declaração de tipo.
 *
 * A primeira versão deste teste casava `coluna:` linha a linha e acusou **11
 * falsos positivos**: `total_tokens: number | null` numa interface,
 * `wa_identity: string | null` num tipo de linha lida, e a montagem de um objeto
 * de resposta HTTP. Nenhum deles toca o banco. Um gate que grita onde não há
 * defeito é um gate que alguém desliga — então o critério passou a ser
 * CONTEXTO, não formato da linha:
 *
 *  1. **Literal dentro da chamada**: `.insert({ coluna: ... })`, com os
 *     parênteses balanceados para não vazar para a chamada seguinte.
 *  2. **Objeto montado antes e passado depois**: `patch.coluna = x` … e, no
 *     mesmo arquivo, `.update(patch)`. Era exatamente a forma das duas
 *     instâncias vivas em `contacts/_handler.ts` e `waha/ingest.ts` — a forma
 *     que uma varredura de chamada, sozinha, não enxerga.
 */
function trechoBalanceado(texto: string, inicioParen: number): string {
  let nivel = 0;
  for (let i = inicioParen; i < texto.length; i++) {
    if (texto[i] === "(") nivel++;
    else if (texto[i] === ")") {
      nivel--;
      if (nivel === 0) return texto.slice(inicioParen, i + 1);
    }
  }
  return texto.slice(inicioParen);
}

function linhaDe(texto: string, indice: number): number {
  return texto.slice(0, indice).split("\n").length;
}

function escritasNoArquivo(conteudo: string, coluna: string): number[] {
  const achados = new Set<number>();
  const literal = new RegExp(`(^|[\\s{,])${coluna}\\s*:`, "m");

  // 1 · literal dentro de insert/update/upsert
  const chamada = /\.(insert|update|upsert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = chamada.exec(conteudo)) !== null) {
    const abre = conteudo.indexOf("(", m.index);
    const bloco = trechoBalanceado(conteudo, abre);
    const dentro = bloco.match(literal);
    if (dentro && dentro.index !== undefined) achados.add(linhaDe(conteudo, abre + dentro.index));
  }

  // 2 · objeto montado campo a campo e depois entregue a insert/update/upsert
  const atrib = new RegExp(`\\b(\\w+)\\.${coluna}\\s*=[^=]`, "g");
  while ((m = atrib.exec(conteudo)) !== null) {
    const variavel = m[1]!;
    const entregue = new RegExp(`\\.(insert|update|upsert)\\s*\\(\\s*${variavel}\\b`);
    if (entregue.test(conteudo)) achados.add(linhaDe(conteudo, m.index));
  }

  return [...achados].sort((a, b) => a - b);
}

describe("colunas geradas", () => {
  it("o schema TEM colunas geradas — sem isto a varredura abaixo passa medindo nada", async () => {
    // Controle positivo do instrumento: se a query mudasse de forma (ou o
    // baseline perdesse as colunas), a varredura percorreria uma lista vazia e
    // ficaria verde para sempre. Zero achados só vale se houve o que procurar.
    const cols = await colunasGeradas();
    expect(cols.length, "esperava colunas GENERATED no schema").toBeGreaterThan(0);
  });

  it("a varredura ENXERGA arquivos — controle positivo do outro lado", () => {
    const arquivos = arquivosDeProducao();
    expect(arquivos.length, "git ls-files não devolveu código de produção").toBeGreaterThan(100);
  });

  it("nenhum caminho de produção escreve numa coluna gerada", async () => {
    const cols = await colunasGeradas();
    const arquivos = arquivosDeProducao();
    const violacoes: string[] = [];

    for (const c of cols) {
      for (const arquivo of arquivos) {
        const conteudo = fs.readFileSync(path.join(process.cwd(), arquivo), "utf8");
        for (const linha of escritasNoArquivo(conteudo, c.coluna)) {
          const aceita = DIVIDA_ACEITA.some((d) => d.arquivo === arquivo && d.coluna === c.coluna);
          if (!aceita) {
            violacoes.push(
              `${arquivo}:${linha} escreve em ${c.tabela}.${c.coluna} — ` +
                `coluna GERADA (${c.expressao}). O Postgres aborta a instrução INTEIRA (428C9).`,
            );
          }
        }
      }
    }

    expect(violacoes, `\n${violacoes.join("\n")}\n`).toEqual([]);
  });

  it("o Postgres REALMENTE recusa — a premissa deste gate, medida e não presumida", async () => {
    const cols = await colunasGeradas();
    const alvo = cols.find((c) => c.tabela === "contacts" && c.coluna === "email_normalized") ?? cols[0]!;

    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ('9e2e7a00-0000-4000-8000-000000000001', 'org-coluna-gerada', 'Gerada LTDA', 'Gerada')
       on conflict (id) do nothing`,
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name, source, email)
       values ('9e2e7a00-0000-4000-8000-000000000001', 'Alvo da coluna gerada', 'manual', 'antes@exemplo.com')
       returning id`,
    );
    const id = rows[0]!.id;

    // O que o código fazia: escrever na derivada junto com a origem.
    await expect(
      pool.query(`update contacts set email = $2, ${alvo.coluna} = $2 where id = $1`, [id, "depois@exemplo.com"]),
      "atribuir a coluna gerada tem de ser recusado",
    ).rejects.toThrow(/can only be updated to DEFAULT|generated column/i);

    // O que ele faz agora: escrever só a origem — e a derivada acompanha.
    await pool.query("update contacts set email = $2 where id = $1", [id, "DEPOIS@Exemplo.com"]);
    const { rows: depois } = await pool.query<{ email: string; email_normalized: string }>(
      "select email, email_normalized from contacts where id = $1",
      [id],
    );
    expect(depois[0]!.email).toBe("DEPOIS@Exemplo.com");
    // A prova de que não se perde nada ao parar de escrever: o banco deriva.
    expect(depois[0]!.email_normalized).toBe("depois@exemplo.com");

    await pool.query("delete from organizations where id = '9e2e7a00-0000-4000-8000-000000000001'");
  });
});
