import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./introspeccao", () => ({ listarTabelas: vi.fn(), descreverTabela: vi.fn() }));
vi.mock("./leitura", async () => {
  const real = (await vi.importActual("./leitura")) as Record<string, unknown>;
  return { ...real, lerTabela: vi.fn() };
});

import { criarDialetoDeLeitura, criarDialetoPostgres, FonteNaoLiberadaError } from "./dialeto";
import type { Fonte, RegraDeFontes } from "./fontes";
import { descreverTabela, listarTabelas } from "./introspeccao";
import { LeituraInvalidaError, lerTabela, montarConsulta } from "./leitura";
import type { PedidoDeLeitura, TabelaExterna } from "./types";

const POOL = {} as pg.Pool;

const CLIENTES: TabelaExterna = {
  schema: "public",
  nome: "clientes",
  tipo: "tabela",
  colunas: [
    { nome: "id", tipo: "uuid", nulavel: false, posicao: 1 },
    { nome: "nome", tipo: "text", nulavel: true, posicao: 2 },
    { nome: "cpf", tipo: "text", nulavel: true, posicao: 3 },
  ],
  chavePrimaria: ["id"],
  estimativaLinhas: 10,
};
const WP_USERS: TabelaExterna = { ...CLIENTES, nome: "wp_users", colunas: [{ nome: "user_pass", tipo: "text", nulavel: true, posicao: 1 }] };

const fonte = (tabela: string, colunas: string[] | null = null): Fonte => ({ schema: "public", tabela, colunas, descricao: "" });
const lista = (...fontes: Fonte[]): RegraDeFontes => ({ modo: "list", fontes });
const TUDO: RegraDeFontes = { modo: "all", fontes: [] };

const pedido = (over: Partial<PedidoDeLeitura> = {}): PedidoDeLeitura => ({
  schema: "public",
  tabela: "clientes",
  colunas: [],
  filtros: [],
  limite: 20,
  offset: 0,
  ...over,
});

beforeEach(() => {
  vi.mocked(listarTabelas).mockReset().mockResolvedValue([CLIENTES, WP_USERS]);
  vi.mocked(descreverTabela).mockReset().mockImplementation(async (_p, _s, tabela) => (tabela === "clientes" ? CLIENTES : tabela === "wp_users" ? WP_USERS : null));
  vi.mocked(lerTabela).mockReset().mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
});

describe("Dialeto PostgreSQL com fontes liberadas", () => {
  it("listarTabelas devolve só as fontes; catalogoCompleto ignora a lista (uso do administrador)", async () => {
    const d = criarDialetoPostgres(POOL, lista(fonte("clientes")));
    expect((await d.listarTabelas()).map((t) => t.nome)).toEqual(["clientes"]);
    expect((await d.catalogoCompleto()).map((t) => t.nome)).toEqual(["clientes", "wp_users"]);
  });

  it("tabela fora da lista: colunasDaTabela é null e NEM consulta o banco de origem", async () => {
    const d = criarDialetoPostgres(POOL, lista(fonte("clientes")));
    expect(await d.colunasDaTabela("public", "wp_users")).toBeNull();
    expect(descreverTabela).not.toHaveBeenCalled();
  });

  it("colunas restritas: o conjunto devolvido tem só as liberadas", async () => {
    const d = criarDialetoPostgres(POOL, lista(fonte("clientes", ["nome"])));
    expect(await d.colunasDaTabela("public", "clientes")).toEqual(new Set(["nome"]));
  });

  it("modo all: comportamento de hoje (todas as colunas, qualquer tabela)", async () => {
    const d = criarDialetoPostgres(POOL, TUDO);
    expect(await d.colunasDaTabela("public", "wp_users")).toEqual(new Set(["user_pass"]));
  });

  it("filtro e ordenação por coluna ESCONDIDA são recusados (composição com o montador real)", async () => {
    const d = criarDialetoPostgres(POOL, lista(fonte("clientes", ["id", "nome"])));
    const permitidas = (await d.colunasDaTabela("public", "clientes"))!;
    expect(() =>
      montarConsulta(pedido({ filtros: [{ coluna: "cpf", operador: "eq", valor: "123" }] }), permitidas),
    ).toThrow(LeituraInvalidaError);
    expect(() => montarConsulta(pedido({ ordem: { coluna: "cpf" } }), permitidas)).toThrow(LeituraInvalidaError);
    expect(() => montarConsulta(pedido({ colunas: ["cpf"] }), permitidas)).toThrow(LeituraInvalidaError);
  });

  describe("lerTabela", () => {
    it("em list, a projeção vazia vira lista EXPLÍCITA das colunas liberadas — nunca *", async () => {
      const d = criarDialetoPostgres(POOL, lista(fonte("clientes", ["id", "nome"])));
      const permitidas = (await d.colunasDaTabela("public", "clientes"))!;
      await d.lerTabela(pedido({ colunas: [] }), permitidas, { limiteMax: 50 });
      const chamada = vi.mocked(lerTabela).mock.calls[0]!;
      expect(chamada[1].colunas).toEqual(["id", "nome"]);
      expect(chamada[3]).toEqual({ limiteMax: 50 });
    });

    it("em all, a projeção vazia continua vazia (como hoje)", async () => {
      const d = criarDialetoPostgres(POOL, TUDO);
      const permitidas = (await d.colunasDaTabela("public", "clientes"))!;
      await d.lerTabela(pedido({ colunas: [] }), permitidas);
      expect(vi.mocked(lerTabela).mock.calls[0]![1].colunas).toEqual([]);
    });

    it("tabela fora da lista: FonteNaoLiberadaError e o banco de origem nem é tocado", async () => {
      const d = criarDialetoPostgres(POOL, lista(fonte("clientes")));
      await expect(d.lerTabela(pedido({ tabela: "wp_users" }), new Set(["user_pass"]))).rejects.toBeInstanceOf(FonteNaoLiberadaError);
      expect(lerTabela).not.toHaveBeenCalled();
    });

    it("fonte sem NENHUMA coluna visível: recusa em vez de virar *", async () => {
      const d = criarDialetoPostgres(POOL, lista(fonte("clientes", ["coluna_que_sumiu"])));
      await expect(d.lerTabela(pedido(), new Set())).rejects.toBeInstanceOf(FonteNaoLiberadaError);
      expect(lerTabela).not.toHaveBeenCalled();
    });
  });
});

describe("criarDialetoDeLeitura (qualquer motor)", () => {
  function operacoes() {
    return {
      listarTabelas: vi.fn(async () => [CLIENTES, WP_USERS]),
      descreverTabela: vi.fn(async (_schema: string, tabela: string) =>
        tabela === "clientes" ? CLIENTES : tabela === "wp_users" ? WP_USERS : null,
      ),
      lerTabela: vi.fn(async (_pedido: PedidoDeLeitura, ..._resto: unknown[]) => ({ colunas: ["id"], linhas: [], limite: 20, offset: 0 })),
      schemaDasReceitas: vi.fn(() => "public"),
      executarReceita: vi.fn(async () => ({ colunas: ["id"], linhas: [], limite: 20, offset: 0, truncado: false })),
    };
  }

  it("em modo list, fonte não marcada: colunasDaTabela devolve null e descreverTabela NÃO é chamada", async () => {
    const op = operacoes();
    const d = criarDialetoDeLeitura(op, lista(fonte("clientes")));
    await expect(d.colunasDaTabela("public", "wp_users")).resolves.toBeNull();
    expect(op.descreverTabela).not.toHaveBeenCalled();
  });

  it("em modo list, lerTabela com a projeção vazia chama op.lerTabela com as colunas explícitas (nunca *)", async () => {
    const op = operacoes();
    const d = criarDialetoDeLeitura(op, lista(fonte("clientes", ["id", "nome"])));
    const permitidas = (await d.colunasDaTabela("public", "clientes"))!;
    await d.lerTabela(pedido({ colunas: [] }), permitidas);
    expect(op.lerTabela).toHaveBeenCalledTimes(1);
    expect(op.lerTabela.mock.calls[0]![0].colunas).toEqual(["id", "nome"]);
  });

  it("em modo all a leitura passa direto a op.lerTabela com o pedido original", async () => {
    const op = operacoes();
    const d = criarDialetoDeLeitura(op, TUDO);
    const p = pedido({ colunas: [] });
    await d.lerTabela(p, new Set());
    expect(op.lerTabela).toHaveBeenCalledTimes(1);
    expect(op.lerTabela.mock.calls[0]![0]).toEqual(p);
  });

  it("executarReceita com tabela não liberada: FonteNaoLiberadaError, o motor não é tocado", async () => {
    const op = operacoes();
    const d = criarDialetoDeLeitura(op, lista(fonte("clientes")));
    await expect(
      d.executarReceita(
        { sql: "select * from wp_users", valores: [], tabelas: ["wp_users"], colunasPorTabela: {} },
        { limiteMax: 5 },
      ),
    ).rejects.toBeInstanceOf(FonteNaoLiberadaError);
    expect(op.executarReceita).not.toHaveBeenCalled();
  });

  describe("executarReceita — regra de fontes (J1, J2, J3)", () => {
    const consultaValida = {
      sql: "select ID, post_title from `wp_posts` where post_type = ?",
      valores: ["product"],
      tabelas: ["wp_posts"],
      colunasPorTabela: { "wp_posts": ["ID", "post_title"] },
    };

    it("J1(a) modo list com fonte marcada no schema certo: passa e chama o motor", async () => {
      const op = operacoes();
      const d = criarDialetoDeLeitura(op, lista(fonte("clientes")));
      // `clientes` tem schema "public", igual ao schemaDasReceitas do dublê.
      await d.executarReceita(
        { ...consultaValida, tabelas: ["clientes"] },
        { limiteMax: 5 },
      );
      expect(op.executarReceita).toHaveBeenCalledTimes(1);
    });

    it("J1(b) modo list com tabela da receita não marcada: fonte_nao_liberada, motor não tocado", async () => {
      const op = operacoes();
      const d = criarDialetoDeLeitura(op, lista(fonte("clientes")));
      await expect(
        d.executarReceita(consultaValida, { limiteMax: 5 }),
      ).rejects.toBeInstanceOf(FonteNaoLiberadaError);
      expect(op.executarReceita).not.toHaveBeenCalled();
    });

    it("J1(c) modo list com fonte marcada em OUTRO schema: fonte_nao_liberada", async () => {
      const op = operacoes();
      const d = criarDialetoDeLeitura(op, lista({ schema: "outro_schema", tabela: "clientes", colunas: null, descricao: "" }));
      // fonte de outro schema não casa com schema "public" do dublê.
      await expect(
        d.executarReceita(
          { ...consultaValida, tabelas: ["clientes"] },
          { limiteMax: 5 },
        ),
      ).rejects.toBeInstanceOf(FonteNaoLiberadaError);
      expect(op.executarReceita).not.toHaveBeenCalled();
    });

    it("J2 modo list com coluna da receita não liberada: sem_colunas_liberadas", async () => {
      // Fonte de clientes libera só ID e post_title; a receita usa post_status.
      const op = operacoes();
      vi.mocked(op.descreverTabela).mockResolvedValueOnce(CLIENTES);
      const d = criarDialetoDeLeitura(
        op,
        lista(fonte("clientes", ["ID", "post_title"])),
      );
      await expect(
        d.executarReceita(
          {
            ...consultaValida,
            tabelas: ["clientes"],
            colunasPorTabela: { clientes: ["ID", "post_title", "post_status"] },
          },
          { limiteMax: 5 },
        ),
      ).rejects.toBeInstanceOf(FonteNaoLiberadaError);
      expect(op.executarReceita).not.toHaveBeenCalled();
    });

    it("J3 consulta com INSERT: validador recusa e o motor NUNCA é chamado", async () => {
      const op = operacoes();
      const d = criarDialetoDeLeitura(op, TUDO);
      await expect(
        d.executarReceita(
          { sql: "insert into wp_posts (post_title) values ('x')", valores: [], tabelas: ["wp_posts"], colunasPorTabela: {} },
          { limiteMax: 5 },
        ),
      ).rejects.toBeInstanceOf(LeituraInvalidaError);
      expect(op.executarReceita).not.toHaveBeenCalled();
    });

    it("J3 consulta com tabela fora da lista da receita: validador recusa, motor não tocado", async () => {
      const op = operacoes();
      const d = criarDialetoDeLeitura(op, TUDO);
      await expect(
        d.executarReceita(
          {
            sql: "select * from wp_posts where id = ?",
            valores: [1],
            tabelas: ["tabela_inexistente"],
            colunasPorTabela: {},
          },
          { limiteMax: 5 },
        ),
      ).rejects.toBeInstanceOf(LeituraInvalidaError);
      expect(op.executarReceita).not.toHaveBeenCalled();
    });
  });
});
