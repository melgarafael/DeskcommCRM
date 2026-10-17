import { beforeEach, describe, expect, it, vi } from "vitest";

const { obterPoolMock, testarPg, fecharPg, fecharTodosPg } = vi.hoisted(() => ({
  obterPoolMock: vi.fn(() => ({ marca: "pool" })),
  testarPg: vi.fn(async () => ({ ok: true as const })),
  fecharPg: vi.fn(async () => undefined),
  fecharTodosPg: vi.fn(async () => undefined),
}));

vi.mock("./conexao", () => ({
  obterPool: obterPoolMock,
  testarConexao: testarPg,
  fecharPool: fecharPg,
  fecharTodosOsPools: fecharTodosPg,
}));

import { DriverIndisponivelError, abrirDialeto, driverDe, fecharPool, fecharTodosOsPools, testarConexao } from "./drivers";
import type { ConexaoExterna } from "./types";

const CONEXAO: ConexaoExterna = {
  id: "conn-1",
  organizationId: "org-1",
  dbType: "postgres",
  label: "Outro CRM",
  host: "db.exemplo.com",
  port: 5432,
  database: "outro_crm",
  username: "leitor",
  password: "segredo",
  sslMode: "require",
  maxRows: 200,
  maxFilters: 20,
  maxResponseBytes: 30_000,
  chaveDoCliente: null,
  sourceMode: "all",
  fontes: [],
  versao: "2026-10-08T00:00:00.000Z",
};

beforeEach(() => {
  obterPoolMock.mockClear();
  testarPg.mockClear();
  fecharPg.mockClear();
  fecharTodosPg.mockClear();
});

describe("registro de drivers", () => {
  it("abrirDialeto (postgres) devolve o dialeto de leitura ligado ao pool da conexão", () => {
    const dialeto = abrirDialeto(CONEXAO);
    expect(obterPoolMock).toHaveBeenCalledTimes(1);
    expect(obterPoolMock).toHaveBeenCalledWith(CONEXAO);
    for (const metodo of ["listarTabelas", "colunasDaTabela", "lerTabela", "catalogoCompleto"] as const) {
      expect(typeof dialeto[metodo]).toBe("function");
    }
  });

  it("a regra de fontes vem da conexão: em modo lista, fonte fora da lista nem chega ao banco", async () => {
    const dialeto = abrirDialeto({ ...CONEXAO, sourceMode: "list", fontes: [] });
    // O pool de mentira não tem `connect`: se o dialeto consultasse o banco, isto lançaria TypeError.
    await expect(dialeto.colunasDaTabela("public", "pedidos")).resolves.toBeNull();
  });

  it("testarConexao delega ao driver da conexão", async () => {
    await expect(testarConexao(CONEXAO)).resolves.toEqual({ ok: true });
    expect(testarPg).toHaveBeenCalledWith(CONEXAO);
  });

  it("fecharPool delega ao driver instalado", async () => {
    await fecharPool("conn-1");
    expect(fecharPg).toHaveBeenCalledWith("conn-1");
  });

  it("fecharTodosOsPools delega ao driver instalado", async () => {
    await fecharTodosOsPools();
    expect(fecharTodosPg).toHaveBeenCalledTimes(1);
  });

  it("driverDe('mysql') recusa com erro claro enquanto o driver não está instalado", () => {
    expect(() => driverDe("mysql")).toThrow(DriverIndisponivelError);
    expect(() => driverDe("mysql")).toThrow(/mysql/);
  });

  it("abrirDialeto de uma conexão mysql recusa do mesmo jeito (nunca cai no PostgreSQL por engano)", () => {
    expect(() => abrirDialeto({ ...CONEXAO, dbType: "mysql" })).toThrow(DriverIndisponivelError);
  });
});
