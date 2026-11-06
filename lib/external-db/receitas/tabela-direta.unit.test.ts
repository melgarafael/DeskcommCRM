/**
 * Receita `tabela-direta` — unit, sem MySQL.
 */
import { describe, expect, it } from "vitest";

import { RECEITA_TABELA_DIRETA } from "./tabela-direta";
import { validarConsultaDeReceita } from "./validador";

const FIXOS_CCT = {
  tabela: "wp_jet_cct_imovel",
  coluna_id: "_ID",
  coluna_titulo: "titulo",
  campos: [
    { chave: "preco", rotulo: "Preço de venda", coluna: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "quartos", rotulo: "Quartos", coluna: "quartos", tipo: "numero", filtro: "minimo" },
    { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "contem" },
  ],
  so_mostrar_quando: { coluna: "cct_status", valor: "publish" },
  esconder_quando: { coluna: "situacao", valores: ["vendido", "alugado"] },
};

describe("receita tabela-direta (unit, sem MySQL)", () => {
  it("monta SQL com id, título e campos mapeados, todos com ?", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(FIXOS_CCT, {}, 5);
    expect(sql).toContain("select `_ID` as id, `titulo` as titulo");
    expect(sql).toContain("from `wp_jet_cct_imovel` t");
    expect(sql).toContain("where");
    expect(sql).toContain("order by `_ID`");
    expect(sql).toContain("limit ?");
    // Todos os valores vêm por placeholder.
    expect(sql.split("?").length - 1).toBe(valores.length);
    expect(valores).toContain("publish");
    expect(valores).toContain("vendido");
    expect(valores).toContain("alugado");
  });

  it("os apelidos de saída vão quotados (chave reservada não quebra a consulta)", () => {
    const fixosComReservada = {
      ...FIXOS_CCT,
      campos: [
        { chave: "key", rotulo: "Chave", coluna: "codigo", tipo: "texto", filtro: "nenhum" },
      ],
      so_mostrar_quando: undefined,
      esconder_quando: undefined,
    };
    const { sql } = RECEITA_TABELA_DIRETA.montar(fixosComReservada, {}, 5);
    expect(sql).toContain("as `key`");
    expect(sql).not.toMatch(/as key\b/);
    expect(() =>
      validarConsultaDeReceita(sql, RECEITA_TABELA_DIRETA.tabelas(fixosComReservada)),
    ).not.toThrow();
  });

  it("o filtro desconhecido lança ErroDeFiltroDesconhecido", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.montar(FIXOS_CCT, { filtros: { inexistente: "x" } }, 5),
    ).toThrow(/não existe nesta receita/);
  });

  it("o filtro de número com texto lança ErroDeFiltroDesconhecido", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.montar(
        FIXOS_CCT,
        { filtros: { quartos: "dois" } },
        5,
      ),
    ).toThrow(/espera um número/);
  });

  it("o filtro de texto com número lança ErroDeFiltroDesconhecido", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.montar(
        FIXOS_CCT,
        { filtros: { bairro: 123 } },
        5,
      ),
    ).toThrow(/espera um texto/);
  });

  it("passa no validador com a tabela liberada", () => {
    const { sql } = RECEITA_TABELA_DIRETA.montar(FIXOS_CCT, {}, 5);
    const tabelas = RECEITA_TABELA_DIRETA.tabelas(FIXOS_CCT);
    expect(tabelas).toEqual(["wp_jet_cct_imovel"]);
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
  });

  it("recusa quando a tabela não está liberada (furo de segurança)", () => {
    const { sql } = RECEITA_TABELA_DIRETA.montar(FIXOS_CCT, {}, 5);
    expect(() => validarConsultaDeReceita(sql, ["outra_tabela"])).toThrow(
      /tabela_nao_liberada:wp_jet_cct_imovel/,
    );
  });

  it("colunas() devolve as colunas mapeadas da tabela para a trava das fontes", () => {
    const colunas = RECEITA_TABELA_DIRETA.colunas(FIXOS_CCT);
    expect(colunas["wp_jet_cct_imovel"]).toContain("_ID");
    expect(colunas["wp_jet_cct_imovel"]).toContain("titulo");
    expect(colunas["wp_jet_cct_imovel"]).toContain("preco");
    expect(colunas["wp_jet_cct_imovel"]).toContain("quartos");
    expect(colunas["wp_jet_cct_imovel"]).toContain("bairro");
  });

  it("descreverFiltros lista os filtros configurados", () => {
    expect(RECEITA_TABELA_DIRETA.descreverFiltros).toBeDefined();
    const descricao = RECEITA_TABELA_DIRETA.descreverFiltros!(FIXOS_CCT);
    expect(descricao).toContain("preco (Preço de venda, maximo)");
    expect(descricao).toContain("quartos (Quartos, minimo)");
    expect(descricao).toContain("bairro (Bairro, contem)");
  });

  it("teto de itens é 5", () => {
    expect(RECEITA_TABELA_DIRETA.tetoDeItens).toBe(5);
    const { sql } = RECEITA_TABELA_DIRETA.montar(FIXOS_CCT, {}, 5);
    expect(sql).toContain("limit ?");
  });

  it("colunas() inclui as colunas de só-mostrar-quando e esconder-quando", () => {
    const colunas = RECEITA_TABELA_DIRETA.colunas(FIXOS_CCT);
    expect(colunas["wp_jet_cct_imovel"]).toContain("cct_status");
    expect(colunas["wp_jet_cct_imovel"]).toContain("situacao");
  });

  it("sem só-mostrar, sem esconder e sem filtro não emite WHERE", () => {
    const fixosSemRegras = {
      tabela: "wp_jet_cct_imovel",
      coluna_id: "_ID",
      coluna_titulo: "titulo",
      campos: [
        { chave: "preco", rotulo: "Preço", coluna: "preco", tipo: "preco", filtro: "maximo" },
      ],
    };
    const { sql } = RECEITA_TABELA_DIRETA.montar(fixosSemRegras, {}, 5);
    expect(sql).not.toMatch(/\bwhere\b/i);
    expect(sql).toContain("from `wp_jet_cct_imovel` t order by `_ID` limit ?");
  });

  it("filtro igual para campo de texto", () => {
    const fixosComIgual = {
      ...FIXOS_CCT,
      campos: [
        { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "igual" },
      ],
      so_mostrar_quando: undefined,
      esconder_quando: undefined,
    };
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixosComIgual,
      { filtros: { bairro: "Centro" } },
      5,
    );
    expect(sql).toContain("`bairro` = ?");
    expect(valores).toContain("Centro");
    expect(sql).not.toContain("%");
  });

  it("LIKE escapa curingas do agente (% e _)", () => {
    const fixosComContem = {
      ...FIXOS_CCT,
      campos: [
        { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "contem" },
      ],
      so_mostrar_quando: undefined,
      esconder_quando: undefined,
    };
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixosComContem,
      { filtros: { bairro: "100% _centro_" } },
      5,
    );
    // Curingas escapados com !, nunca crus no texto.
    expect(sql).toContain("like ? escape '!'");
    expect(valores[0]).toBe("%100!% !_centro!_%");
    // O texto do SQL não contém o curinga cru.
    expect(sql).not.toContain("100%");
    expect(sql).not.toContain("_centro_");
  });
});
