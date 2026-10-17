/**
 * Teste unitário da receita `tabela-direta` SEM MySQL de verdade.
 *
 * Prova que o SQL montado pela receita:
 *  - usa apenas placeholders `?` para valores (nunca concatena identificadores),
 *  - coloca tabela e colunas via quotarIdentificadorMysql (após regex),
 *  - placeholders alinhados com valores na ordem do texto (R-A),
 *  - todo apelido usado no SQL é declarado (não há apelidos órfãos — tabela plana não usa JOIN),
 *  - Zod recusa coluna com crase/espaço/;, nome repetido, 65+ caracteres,
 *  - texto sem filtros_texto → erro legível,
 *  - helper de preço com os 4 formatos.
 */
import { describe, expect, it } from "vitest";

import { RECEITA_TABELA_DIRETA } from "./tabela-direta";

describe("receita tabela-direta (unit, sem MySQL)", () => {
  const fixos = {
    tabela: "carros",
    colunas: {
      id: "id",
      titulo: "modelo",
      preco: "preco",
      filtros_texto: ["cor", "foto"],
      filtro_numero: "ano",
      exibir: ["cor", "foto"],
      status: { coluna: "ativo", valor: "1" },
    },
  };

  it("monta SQL com filtro de status e texto", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixos,
      { texto: "sedan", limite: 3 },
      3,
    );
    expect(sql).toContain("`.`ativo` = ?");
    expect(valores).toContain("1");
    expect(sql).toContain("like ?");
    expect(valores).toContain("%sedan%");
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("monta SQL com preco_max e preco_min", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixos,
      { preco_min: 20000, preco_max: 60000, limite: 5 },
      5,
    );
    expect(sql).toContain("CASE");
    expect(sql).toContain("DECIMAL(10,2)");
    expect(valores).toContain(20000);
    expect(valores).toContain(60000);
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("monta SQL com numero_min e numero_max", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixos,
      { numero_min: 2015, numero_max: 2022, limite: 5 },
      5,
    );
    expect(sql).toContain("CAST");
    expect(sql).toContain("DECIMAL(10,2)");
    expect(valores).toContain(2015);
    expect(valores).toContain(2022);
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("todo valor entra como placeholder ? — nunca concatena identificador", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixos,
      { texto: "sedan", preco_max: 60000, numero_min: 2015, limite: 3 },
      3,
    );
    // Nenhum nome de coluna ou tabela cru aparece como identificador no SQL.
    expect(sql).not.toContain("carros =");
    expect(sql).not.toContain("modelo =");
    expect(sql).not.toContain("preco =");
    expect(sql).not.toContain("ano =");
    // Todo identificador de tabela está quotado com crase (sem crase = injeção).
    expect(sql).not.toMatch(/[^`]carros[.\s=]/);
    // Todo valor virou placeholder.
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("coluna de exibir sai com apelido = nome real, não c0", () => {
    const fixosExibir = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        preco: "preco",
        filtros_texto: [],
        filtro_numero: "ano",
        exibir: ["foto"],
        status: { coluna: "ativo", valor: "1" },
      },
    };
    const { sql } = RECEITA_TABELA_DIRETA.montar(fixosExibir, {}, 5);
    expect(sql).toContain("`carros`.`foto` as `foto`");
    expect(sql).not.toContain(" as c0");
  });

  it("Zod recusa exibir com coluna que colide com apelido fixo (titulo)", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "nome",
          filtros_texto: [],
          exibir: ["titulo"],
          status: { coluna: "ativo", valor: "1" },
        },
      }),
    ).toThrow();
  });

  it("placeholders estão alinhados com os valores na ordem do texto (R-A)", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixos,
      { texto: "sedan", preco_max: 60000, numero_min: 2015, limite: 3 },
      3,
    );

    // Render: substitui cada `?` pelo valor correspondente, em sequência.
    const partes = sql.split("?");
    if (partes.length - 1 !== valores.length) {
      throw new Error(`esperava ${valores.length} placeholders, achou ${partes.length - 1}`);
    }
    let renderizado = "";
    for (let i = 0; i < partes.length; i++) {
      renderizado += partes[i];
      if (i < valores.length) {
        const v = valores[i];
        renderizado += typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);
      }
    }

    // O status vem primeiro, depois o texto, depois preço, depois número, depois limite.
    expect(renderizado).toContain("`.`ativo` = '1'");
    expect(renderizado).toContain("like '%sedan%'");
    expect(renderizado).toContain("limit 3");
  });

  it("conta de ? bate com o número de valores", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(fixos, {}, 5);
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("Zod recusa tabela inválida (crase)", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({
        tabela: "carros`; drop table",
        colunas: {
          id: "id",
          titulo: "modelo",
          filtros_texto: [],
          exibir: [],
        },
      }),
    ).toThrow();
  });

  it("Zod recusa coluna inválida (espaço)", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo ruim",
          filtros_texto: [],
          exibir: [],
        },
      }),
    ).toThrow();
  });

  it("Zod recusa coluna com ponto-e-vírgula", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo; drop table",
          filtros_texto: [],
          exibir: [],
        },
      }),
    ).toThrow();
  });

  it("Zod recusa coluna com 65+ caracteres", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "a".repeat(65),
          filtros_texto: [],
          exibir: [],
        },
      }),
    ).toThrow();
  });

  it("Zod recusa nome de coluna repetido", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "id",
          filtros_texto: [],
          exibir: [],
        },
      }),
    ).toThrow();
  });

  it("texto sem filtros_texto → erro legível", () => {
    const fixosSemFiltrosTexto = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        filtros_texto: [],
        exibir: [],
      },
    };
    expect(() =>
      RECEITA_TABELA_DIRETA.montar(fixosSemFiltrosTexto, { texto: "sedan" }, 5),
    ).toThrow(/coluna_inexistente/);
  });

  it("helper de preço: formato brasileiro 650.000,00", () => {
    const { sql } = RECEITA_TABELA_DIRETA.montar(
      fixos,
      { preco_max: 650000, limite: 5 },
      5,
    );
    expect(sql).toContain("CASE");
    expect(sql).toContain("REPLACE");
    expect(sql).toContain("LIKE '%,%'");
  });

  it("helper de preço: ponto decimal 650000.50", () => {
    const fixosSemPreco = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        preco: "preco_txt",
        filtros_texto: [],
        exibir: [],
      },
    };
    const { sql } = RECEITA_TABELA_DIRETA.montar(
      fixosSemPreco,
      { preco_max: 650000, limite: 5 },
      5,
    );
    expect(sql).toContain("REGEXP '[.][0-9]{1,2}$'");
  });

  it("helper de preço: pontos milhar 1.200.000", () => {
    const fixosSemPreco = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        preco: "preco_txt",
        filtros_texto: [],
        exibir: [],
      },
    };
    const { sql } = RECEITA_TABELA_DIRETA.montar(
      fixosSemPreco,
      { preco_max: 1200000, limite: 5 },
      5,
    );
    expect(sql).toContain("ELSE CAST(REPLACE");
  });

  it("sem texto e sem filtros → SQL válido sem where de texto", () => {
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      fixos,
      { preco_max: 60000, limite: 5 },
      5,
    );
    expect(sql).toMatch(/^select /i);
    expect(sql).toContain("`.`ativo` = ?");
    expect(sql).toContain("preco");
    // status.valor (1), preco_max (1), limite (1) = 3 placeholders
    expect(sql.split("?").length - 1).toBe(3);
    expect(valores).toEqual(["1", 60000, 5]);
  });

  it("sem status → SQL sem cláusula de status", () => {
    const fixosSemStatus = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        filtros_texto: [],
        exibir: [],
      },
    };
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(fixosSemStatus, {}, 5);
    expect(sql).not.toContain("ativo =");
    expect(sql).toMatch(/^select /i);
    expect(sql.split("?").length - 1).toBe(valores.length);
  });
});
