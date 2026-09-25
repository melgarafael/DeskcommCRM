import type pg from "pg";
import { describe, expect, it } from "vitest";

import { colunasDaTabela, descreverTabela, listarTabelas } from "./introspeccao";

interface LinhaCatalogo {
  schema: string;
  nome: string;
  tipo: string;
  coluna: string;
  tipo_dado: string;
  nulavel: string;
  posicao: number;
  chave_primaria: string[] | string | null;
  estimativa: number;
}

/** Pool falso que devolve as linhas do catálogo para o SELECT e ignora `begin`. */
function poolFalso(rows: LinhaCatalogo[]) {
  const consultas: string[] = [];
  const client = {
    query: async (text: string) => {
      consultas.push(text);
      return text.trimStart().startsWith("select")
        ? { rows, fields: [], rowCount: rows.length }
        : { rows: [], fields: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as pg.Pool;
  return { pool, consultas };
}

const ROWS: LinhaCatalogo[] = [
  { schema: "public", nome: "pedidos", tipo: "BASE TABLE", coluna: "id", tipo_dado: "uuid", nulavel: "NO", posicao: 1, chave_primaria: ["id"], estimativa: 1234.5 },
  { schema: "public", nome: "pedidos", tipo: "BASE TABLE", coluna: "total", tipo_dado: "numeric", nulavel: "YES", posicao: 2, chave_primaria: ["id"], estimativa: 1234.5 },
  { schema: "vendas", nome: "resumo", tipo: "VIEW", coluna: "mes", tipo_dado: "text", nulavel: "YES", posicao: 1, chave_primaria: null, estimativa: -1 },
  // O driver devolvia a PK como o literal cru `"{id}"` (array `name[]` que ele
  // não parseia) — o contrato é `string[]` e a tela quebrava ao iterar.
  { schema: "public", nome: "legado", tipo: "BASE TABLE", coluna: "id", tipo_dado: "uuid", nulavel: "NO", posicao: 1, chave_primaria: "{id}", estimativa: 5 },
  { schema: "public", nome: "composta", tipo: "BASE TABLE", coluna: "org", tipo_dado: "uuid", nulavel: "NO", posicao: 1, chave_primaria: "{org,seq}", estimativa: 5 },
];

describe("introspecção ao vivo", () => {
  it("agrupa colunas por tabela e mapeia o tipo", async () => {
    const { pool } = poolFalso(ROWS);
    const tabelas = await listarTabelas(pool);
    expect(tabelas).toHaveLength(4);

    const pedidos = tabelas.find((t) => t.nome === "pedidos");
    expect(pedidos?.schema).toBe("public");
    expect(pedidos?.tipo).toBe("tabela");
    expect(pedidos?.colunas.map((c) => c.nome)).toEqual(["id", "total"]);
    expect(pedidos?.colunas[0]?.nulavel).toBe(false);
    expect(pedidos?.colunas[1]?.nulavel).toBe(true);
    expect(pedidos?.chavePrimaria).toEqual(["id"]);
    expect(pedidos?.estimativaLinhas).toBe(1235);

    const resumo = tabelas.find((t) => t.nome === "resumo");
    expect(resumo?.tipo).toBe("view");
    expect(resumo?.chavePrimaria).toEqual([]); // view não tem PK
    // `reltuples` de view é -1; nunca vira contagem negativa na tela.
    expect(resumo?.estimativaLinhas).toBe(0);
  });

  it("a PK é SEMPRE string[] — o literal `{...}` do driver também vira array", async () => {
    const { pool } = poolFalso(ROWS);
    const tabelas = await listarTabelas(pool);
    expect(tabelas.find((t) => t.nome === "legado")?.chavePrimaria).toEqual(["id"]);
    expect(tabelas.find((t) => t.nome === "composta")?.chavePrimaria).toEqual(["org", "seq"]);
  });

  it("descreverTabela devolve a tabela pedida e `null` quando não existe", async () => {
    const { pool } = poolFalso(ROWS);
    await expect(descreverTabela(pool, "public", "pedidos")).resolves.toMatchObject({
      schema: "public",
      nome: "pedidos",
    });

    const vazio = poolFalso([]);
    await expect(descreverTabela(vazio.pool, "public", "nao_existe")).resolves.toBeNull();
  });

  it("colunasDaTabela devolve o conjunto de colunas — ou `null` se a tabela some", async () => {
    const { pool } = poolFalso(ROWS);
    await expect(colunasDaTabela(pool, "public", "pedidos")).resolves.toEqual(new Set(["id", "total"]));

    const vazio = poolFalso([]);
    await expect(colunasDaTabela(vazio.pool, "public", "nao_existe")).resolves.toBeNull();
  });

  it("a leitura passa por transação somente-leitura", async () => {
    const { pool, consultas } = poolFalso(ROWS);
    await listarTabelas(pool);
    expect(consultas[0]).toBe("begin read only");
    expect(consultas[consultas.length - 1]).toBe("commit");
  });
});
