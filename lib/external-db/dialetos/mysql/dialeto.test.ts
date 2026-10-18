/**
 * A LIGAÇÃO do dialeto MySQL: `schemaDasReceitas()` tem de ser o banco da conexão.
 * Uma sabotagem de teste esquecida (`() => ""`) fez TODA receita falhar em produção
 * com "fonte não liberada", e nenhum teste enxergava, porque os outros exercitam
 * `criarDialetoDeLeitura` com um motor falso. Aqui o motor é o REAL
 * (`criarDialetoMysql`); só o pool e as funções que falam com o servidor são dublês.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pool: { __pool: true },
  obterPool: vi.fn(),
  listar: vi.fn(),
  descrever: vi.fn(),
  lerTabela: vi.fn(),
  executar: vi.fn(),
}));

vi.mock("./conexao", () => ({ obterPoolMysql: mocks.obterPool }));
vi.mock("./introspeccao", () => ({ listarTabelasMysql: mocks.listar, descreverTabelaMysql: mocks.descrever }));
vi.mock("./leitura", () => ({ lerTabelaMysql: mocks.lerTabela, executarReceitaMysql: mocks.executar }));

import type { ConexaoExterna } from "../../types";
import { criarDialetoMysql } from "./dialeto";

const conexao = { database: "loja_wp", maxResponseBytes: 4096 } as unknown as ConexaoExterna;

const tabela = {
  schema: "loja_wp",
  nome: "wp_posts",
  tipo: "tabela" as const,
  colunas: [{ nome: "ID", tipo: "bigint", nulavel: false, posicao: 1 }],
  chavePrimaria: ["ID"],
  estimativaLinhas: 1,
};

const consulta = { sql: "select 1", valores: [], tabelas: ["wp_posts"], colunasPorTabela: { wp_posts: ["ID"] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.obterPool.mockReturnValue(mocks.pool);
  mocks.descrever.mockResolvedValue(tabela);
  mocks.executar.mockResolvedValue({ colunas: ["x"], linhas: [], limite: 5, offset: 0, truncado: false });
});

describe("criarDialetoMysql: o schema das receitas é o banco da conexão", () => {
  it("schemaDasReceitas() devolve conexao.database", () => {
    const d = criarDialetoMysql(conexao, { modo: "all", fontes: [] });
    expect(d.schemaDasReceitas()).toBe("loja_wp");
  });

  it("receita com regra `list` que libera a tabela NO banco da conexão chega ao motor", async () => {
    const regra = { modo: "list" as const, fontes: [{ schema: "loja_wp", tabela: "wp_posts", colunas: null }] };
    const d = criarDialetoMysql(conexao, regra as never);

    const r = await d.executarReceita(consulta, { limiteMax: 5 });

    expect(r.truncado).toBe(false);
    expect(mocks.executar).toHaveBeenCalledTimes(1);
    expect(mocks.executar).toHaveBeenCalledWith(mocks.pool, "loja_wp", consulta, 4096, { limiteMax: 5 });
    expect(mocks.descrever).toHaveBeenCalledWith(mocks.pool, "loja_wp", "loja_wp", "wp_posts");
  });

  it("tabela liberada em OUTRO schema não libera a receita (continua fechado)", async () => {
    const regra = { modo: "list" as const, fontes: [{ schema: "outro", tabela: "wp_posts", colunas: null }] };
    const d = criarDialetoMysql(conexao, regra as never);
    await expect(d.executarReceita(consulta, { limiteMax: 5 })).rejects.toThrow("fonte_nao_liberada");
    expect(mocks.executar).not.toHaveBeenCalled();
  });
});
