import { beforeEach, describe, expect, it, vi } from "vitest";

const { consultarMock } = vi.hoisted(() => ({ consultarMock: vi.fn() }));
vi.mock("./conexao", () => ({ consultarMysql: consultarMock }));

import { LeituraInvalidaError } from "../../montagem";
import { lerTabelaMysql } from "./leitura";
import type { PoolMysql } from "./conexao";
import type { PedidoDeLeitura } from "../../types";

const POOL = {} as PoolMysql;
const PERMITIDAS = new Set(["id", "nome", "foto"]);
const pedido = (extra: Partial<PedidoDeLeitura> = {}): PedidoDeLeitura => ({
  schema: "wp",
  tabela: "pedidos",
  colunas: ["id", "nome"],
  filtros: [],
  limite: 50,
  offset: 0,
  ...extra,
});

beforeEach(() => consultarMock.mockReset());

describe("lerTabelaMysql", () => {
  it("monta o SELECT do MySQL, executa e devolve colunas, linhas, limite e offset", async () => {
    consultarMock.mockResolvedValue({ rows: [{ id: 1, nome: "a" }], fields: [{ name: "id" }, { name: "nome" }] });
    const r = await lerTabelaMysql(POOL, "wp", pedido({ filtros: [{ coluna: "nome", operador: "eq", valor: "a" }] }), PERMITIDAS);
    expect(consultarMock.mock.calls[0]![1]).toBe("select `id`, `nome` from `wp`.`pedidos` where `nome` = ? limit 50 offset 0");
    expect(consultarMock.mock.calls[0]![2]).toEqual(["a"]);
    expect(r).toEqual({ colunas: ["id", "nome"], linhas: [{ id: 1, nome: "a" }], limite: 50, offset: 0 });
  });

  it("binário vira 0x…, bigint vira texto, texto enorme é truncado", async () => {
    consultarMock.mockResolvedValue({
      rows: [{ foto: Buffer.from([0xde, 0xad]), id: 10n, nome: "x".repeat(20_001) }],
      fields: [{ name: "foto" }, { name: "id" }, { name: "nome" }],
    });
    const r = await lerTabelaMysql(POOL, "wp", pedido({ colunas: [] }), PERMITIDAS);
    expect(r.linhas[0]!.foto).toBe("0xdead");
    expect(r.linhas[0]!.id).toBe("10");
    expect(String(r.linhas[0]!.nome)).toContain("truncado");
  });

  it("schema diferente do banco da conexão é recusado antes de consultar", async () => {
    await expect(lerTabelaMysql(POOL, "wp", pedido({ schema: "mysql" }), PERMITIDAS)).rejects.toThrow(LeituraInvalidaError);
    expect(consultarMock).not.toHaveBeenCalled();
  });

  it("coluna fora das permitidas é recusada antes de consultar", async () => {
    await expect(lerTabelaMysql(POOL, "wp", pedido({ colunas: ["senha"] }), PERMITIDAS)).rejects.toThrow(/coluna_inexistente/);
    expect(consultarMock).not.toHaveBeenCalled();
  });
});
