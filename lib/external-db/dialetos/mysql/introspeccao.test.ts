import { beforeEach, describe, expect, it, vi } from "vitest";

const { consultarMock } = vi.hoisted(() => ({ consultarMock: vi.fn() }));
vi.mock("./conexao", () => ({ consultarMysql: consultarMock }));

import { colunasDaTabelaMysql, descreverTabelaMysql, listarTabelasMysql } from "./introspeccao";
import type { PoolMysql } from "./conexao";

const POOL = {} as PoolMysql;

function linha(extra: Record<string, unknown> = {}) {
  return {
    schema: "wp",
    nome: "pedidos",
    tipo: "BASE TABLE",
    coluna: "id",
    tipo_dado: "int",
    nulavel: "NO",
    posicao: 1,
    chave_primaria: "id",
    estimativa: 120,
    ...extra,
  };
}

beforeEach(() => consultarMock.mockReset());

describe("listarTabelasMysql", () => {
  it("fica preso ao banco da conexão (parâmetro, nunca concatenado) e usa aliases em minúscula", async () => {
    consultarMock.mockResolvedValue({ rows: [], fields: [] });
    await listarTabelasMysql(POOL, "wp");
    const [, sql, valores] = consultarMock.mock.calls[0]!;
    expect(valores).toEqual(["wp", "wp"]);
    expect(sql).toContain("c.table_schema = ?");
    expect(sql).toContain("as `schema`");
    expect(sql).toContain("information_schema.statistics");
    expect(sql).toContain("'PRIMARY'");
    expect(sql).not.toContain("'wp'"); // o nome do banco nunca é concatenado
  });

  it("agrupa as colunas por tabela, converte tipo, PK e estimativa", async () => {
    consultarMock.mockResolvedValue({
      rows: [
        linha(),
        linha({ coluna: "total", tipo_dado: "decimal", nulavel: "YES", posicao: 2 }),
        linha({ nome: "v_pedidos", tipo: "VIEW", chave_primaria: null, estimativa: 0, coluna: "id" }),
      ],
      fields: [],
    });
    const tabelas = await listarTabelasMysql(POOL, "wp");
    expect(tabelas).toHaveLength(2);
    expect(tabelas[0]).toEqual({
      schema: "wp",
      nome: "pedidos",
      tipo: "tabela",
      colunas: [
        { nome: "id", tipo: "int", nulavel: false, posicao: 1 },
        { nome: "total", tipo: "decimal", nulavel: true, posicao: 2 },
      ],
      chavePrimaria: ["id"],
      estimativaLinhas: 120,
    });
    expect(tabelas[1]).toMatchObject({ nome: "v_pedidos", tipo: "view", chavePrimaria: [], estimativaLinhas: 0 });
  });

  it("PK composta chega como texto separado por vírgula e vira lista na ordem do índice", async () => {
    consultarMock.mockResolvedValue({ rows: [linha({ chave_primaria: "org_id,id" })], fields: [] });
    const [t] = await listarTabelasMysql(POOL, "wp");
    expect(t!.chavePrimaria).toEqual(["org_id", "id"]);
  });
});

describe("descreverTabelaMysql / colunasDaTabelaMysql", () => {
  it("schema diferente do banco da conexão: não existe (nem consulta)", async () => {
    await expect(descreverTabelaMysql(POOL, "wp", "mysql", "user")).resolves.toBeNull();
    expect(consultarMock).not.toHaveBeenCalled();
  });

  it("tabela do banco: descreve; inexistente: null; colunas viram Set", async () => {
    consultarMock.mockResolvedValueOnce({ rows: [linha(), linha({ coluna: "total", posicao: 2 })], fields: [] });
    const d = await descreverTabelaMysql(POOL, "wp", "wp", "pedidos");
    expect(d?.nome).toBe("pedidos");
    expect(consultarMock.mock.calls[0]![2]).toEqual(["wp", "wp", "pedidos"]);

    consultarMock.mockResolvedValueOnce({ rows: [], fields: [] });
    await expect(descreverTabelaMysql(POOL, "wp", "wp", "nada")).resolves.toBeNull();

    consultarMock.mockResolvedValueOnce({ rows: [linha(), linha({ coluna: "total", posicao: 2 })], fields: [] });
    await expect(colunasDaTabelaMysql(POOL, "wp", "wp", "pedidos")).resolves.toEqual(new Set(["id", "total"]));
  });
});
