import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./introspeccao", () => ({ listarTabelas: vi.fn(), descreverTabela: vi.fn() }));
vi.mock("./leitura", async () => {
  const real = (await vi.importActual("./leitura")) as Record<string, unknown>;
  return { ...real, lerTabela: vi.fn() };
});

import { criarDialetoPostgres, FonteNaoLiberadaError } from "./dialeto";
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
