import { beforeEach, describe, expect, it, vi } from "vitest";

const { criarPool, criarConexao } = vi.hoisted(() => ({
  criarPool: vi.fn(),
  criarConexao: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({ default: { createPool: criarPool, createConnection: criarConexao } }));

import {
  configMysql,
  consultarMysql,
  fecharPoolMysql,
  fecharTodosOsPoolsMysql,
  obterPoolMysql,
  testarConexaoMysql,
  type PoolMysql,
} from "./conexao";
import type { ConexaoExterna } from "../../types";

function conexao(extra: Partial<ConexaoExterna> = {}): ConexaoExterna {
  return {
    id: "conn-1",
    organizationId: "org-1",
    dbType: "mysql",
    label: "WP",
    host: "db.exemplo.com",
    port: 3306,
    database: "wp",
    username: "leitor",
    password: "segredo",
    sslMode: "require",
    maxRows: 200,
    maxFilters: 20,
    maxResponseBytes: 30_000,
    chaveDoCliente: null,
    sourceMode: "all",
    fontes: [],
    versao: "v1",
    ...extra,
  };
}

function conexaoEmprestada(falhaEm?: string) {
  const chamadas: string[] = [];
  const emprestada = {
    chamadas,
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      chamadas.push(sql);
      if (falhaEm && sql.startsWith(falhaEm)) throw new Error("falhou");
      return [[], []];
    }),
    execute: vi.fn(async (sql: string, valores: unknown[]) => {
      chamadas.push(`EXECUTE ${sql} ${JSON.stringify(valores)}`);
      if (falhaEm === "EXECUTE") throw new Error("falhou");
      return [[{ id: 1 }], [{ name: "id" }]];
    }),
  };
  return emprestada;
}

beforeEach(() => {
  criarPool.mockReset();
  criarConexao.mockReset();
});

describe("configMysql", () => {
  it("segue a spec: sem LOAD DATA LOCAL, sem várias sentenças, datas e números grandes como texto, limites do PostgreSQL", () => {
    const c = configMysql(conexao());
    expect(c).toMatchObject({
      host: "db.exemplo.com",
      port: 3306,
      user: "leitor",
      password: "segredo",
      database: "wp",
      connectionLimit: 2,
      connectTimeout: 5_000,
      idleTimeout: 30_000,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    expect(c.flags).toEqual(["-LOCAL_FILES"]);
  });

  it("TLS: disable omite a opção ssl; prefer/require cifram sem verificar; verify-* verificam", () => {
    expect("ssl" in configMysql(conexao({ sslMode: "disable" }))).toBe(false);
    expect(configMysql(conexao({ sslMode: "prefer" })).ssl).toEqual({ rejectUnauthorized: false });
    expect(configMysql(conexao({ sslMode: "require" })).ssl).toEqual({ rejectUnauthorized: false });
    expect(configMysql(conexao({ sslMode: "verify-ca" })).ssl).toEqual({ rejectUnauthorized: true });
    expect(configMysql(conexao({ sslMode: "verify-full" })).ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe("obterPoolMysql — cache e invalidação", () => {
  it("a mesma conexão devolve o mesmo pool; versão, host ou credencial nova derrubam o antigo", async () => {
    const fim = vi.fn(async () => undefined);
    criarPool.mockImplementation(() => ({ end: fim }));
    await fecharTodosOsPoolsMysql();
    const a = obterPoolMysql(conexao());
    expect(obterPoolMysql(conexao())).toBe(a);
    expect(criarPool).toHaveBeenCalledTimes(1);
    const b = obterPoolMysql(conexao({ versao: "v2" }));
    expect(b).not.toBe(a);
    expect(fim).toHaveBeenCalledTimes(1);
    await fecharPoolMysql("conn-1");
    expect(fim).toHaveBeenCalledTimes(2);
  });
});

describe("consultarMysql — somente leitura, a cada empréstimo", () => {
  it("aplica as travas, abre a transação READ ONLY, executa preparado e confirma", async () => {
    const emprestada = conexaoEmprestada();
    const pool: PoolMysql = { getConnection: async () => emprestada as never, end: async () => undefined };
    const r = await consultarMysql(pool, "select 1 where x = ?", ["a", undefined]);
    expect(emprestada.chamadas).toEqual([
      "SET SESSION max_execution_time = 10000",
      "SET SESSION lock_wait_timeout = 5",
      "START TRANSACTION READ ONLY",
      'EXECUTE select 1 where x = ? ["a",null]',
      "COMMIT",
    ]);
    expect(r.rows).toEqual([{ id: 1 }]);
    expect(r.fields.map((f) => f.name)).toEqual(["id"]);
    expect(emprestada.release).toHaveBeenCalledTimes(1);
  });

  it("falha na consulta: desfaz a transação e SEMPRE devolve a conexão ao pool", async () => {
    const emprestada = conexaoEmprestada("EXECUTE");
    const pool: PoolMysql = { getConnection: async () => emprestada as never, end: async () => undefined };
    await expect(consultarMysql(pool, "select 1", [])).rejects.toThrow("falhou");
    expect(emprestada.chamadas).toContain("ROLLBACK");
    expect(emprestada.chamadas).not.toContain("COMMIT");
    expect(emprestada.release).toHaveBeenCalledTimes(1);
  });
});

describe("testarConexaoMysql", () => {
  function conexaoDeTeste(linhasDeGrants: string[] | Error) {
    const chamadas: string[] = [];
    const c = {
      end: vi.fn(async () => undefined),
      on: vi.fn(),
      query: vi.fn(async (sql: string) => {
        chamadas.push(sql);
        if (sql === "SHOW GRANTS") {
          if (linhasDeGrants instanceof Error) throw linhasDeGrants;
          return [linhasDeGrants.map((g) => ({ "Grants for u@%": g })), []];
        }
        return [[{ 1: 1 }], []];
      }),
    };
    criarConexao.mockResolvedValue(c);
    return { c, chamadas };
  }

  it("usuário só-leitura: ok, sem aviso, e a conexão descartável é encerrada", async () => {
    const { c } = conexaoDeTeste(["GRANT SELECT ON `wp`.`v` TO `u`@`%`"]);
    await expect(testarConexaoMysql(conexao())).resolves.toEqual({ ok: true });
    expect(c.end).toHaveBeenCalledTimes(1);
  });

  it("usuário que escreve: ok COM aviso", async () => {
    conexaoDeTeste(["GRANT ALL PRIVILEGES ON `wp`.* TO `u`@`%`"]);
    const r = await testarConexaoMysql(conexao());
    expect(r.ok).toBe(true);
    expect(r.ok && r.aviso).toContain("pode escrever");
  });

  it("SHOW GRANTS recusado não derruba o teste: ok com o aviso de não conferir", async () => {
    conexaoDeTeste(new Error("denied"));
    const r = await testarConexaoMysql(conexao());
    expect(r.ok).toBe(true);
    expect(r.ok && r.aviso).toContain("Não consegui conferir os privilégios");
  });

  it("falha ao conectar: erro curto, sem senha, e a conexão não vaza", async () => {
    criarConexao.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:3306\n    at ..."));
    const r = await testarConexaoMysql(conexao());
    expect(r).toEqual({ ok: false, erro: "connect ECONNREFUSED 10.0.0.1:3306" });
    expect(JSON.stringify(r)).not.toContain("segredo");
  });
});
