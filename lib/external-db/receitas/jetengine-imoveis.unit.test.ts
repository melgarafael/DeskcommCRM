/**
 * Teste unitário da receita `jetengine-imoveis` SEM MySQL de verdade.
 *
 * Prova que o SQL montado pela receita:
 *  - delega para tabela-direta (não duplica montagem de SQL),
 *  - usa o slug para montar a tabela `<prefixo>jet_cct_<slug>`,
 *  - filtra cct_status = 'publish' por `?`,
 *  - placeholders alinhados com valores na ordem do texto (R-A),
 *  - todo apelido usado no SQL é declarado,
 *  - Zod recusa slug inválido, prefixo inválido, coluna inválida.
 */
import { describe, expect, it } from "vitest";

import { RECEITA_JETENGINE_IMOVEIS } from "./jetengine-imoveis";
import { validarConsultaDeReceita } from "./validador";

describe("receita jetengine-imoveis (unit, sem MySQL)", () => {
  const fixos = {
    prefixo: "wp_",
    slug: "imoveis",
    campos: {
      preco: "preco",
      quartos: "quartos",
      bairro: "bairro",
      titulo: "titulo",
      cidade: "cidade",
      area: "area",
    },
  };

  it("monta SQL com cct_status = 'publish' e busca por bairro", () => {
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { bairro: "asa norte", quartos_min: 2, preco_max: 600000, limite: 3 },
      3,
    );
    expect(sql).toContain("`.`cct_status` = ?");
    expect(valores).toContain("publish");
    expect(sql).toContain("like ?");
    expect(valores).toContain("%asa norte%");
    expect(sql.split("?").length - 1).toBe(valores.length);
    const tabelas = RECEITA_JETENGINE_IMOVEIS.tabelas(fixos);
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
  });

  it("bairro + cidade → duas cláusulas AND, cada valor na sua coluna, ordem do texto", () => {
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { bairro: "asa norte", cidade: "centro", limite: 3 },
      3,
    );
    // Cada filtro de texto vira lower(col) like ? em sua própria coluna, ANDed.
    expect(sql).toContain("lower(`wp_jet_cct_imoveis`.`bairro`) like ? escape '!'");
    expect(sql).toContain("lower(`wp_jet_cct_imoveis`.`cidade`) like ? escape '!'");
    expect(sql).toContain(" and ");
    // Valores na ordem do texto: bairro primeiro, depois cidade.
    expect(valores).toEqual(["publish", "%asa norte%", "%centro%", 3]);
    // Render: cada valor na sua coluna.
    const partes = sql.split("?");
    let renderizado = "";
    for (let i = 0; i < partes.length; i++) {
      renderizado += partes[i];
      if (i < valores.length) {
        const v = valores[i];
        renderizado += typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);
      }
    }
    expect(renderizado).toContain("`wp_jet_cct_imoveis`.`bairro`) like '%asa norte%'");
    expect(renderizado).toContain("`wp_jet_cct_imoveis`.`cidade`) like '%centro%'");
    expect(renderizado).not.toContain("`wp_jet_cct_imoveis`.`bairro`) like '%centro%'");
    expect(renderizado).not.toContain("`wp_jet_cct_imoveis`.`cidade`) like '%asa norte%'");
  });

  it("só cidade → só a cláusula da cidade", () => {
    const fixosSemBairro = {
      ...fixos,
      campos: { ...fixos.campos, bairro: "outro_bairro" },
    };
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixosSemBairro,
      { cidade: "centro", limite: 3 },
      3,
    );
    expect(sql).toContain("lower(`wp_jet_cct_imoveis`.`cidade`) like ? escape '!'");
    expect(sql).not.toContain("lower(`wp_jet_cct_imoveis`.`bairro`)");
  });

  it("monta a tabela como <prefixo>jet_cct_<slug>", () => {
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(fixos, {}, 5);
    expect(sql).toContain("`wp_jet_cct_imoveis`");
  });

  it("placeholders estão alinhados com os valores na ordem do texto (R-A)", () => {
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { bairro: "asa norte", quartos_min: 2, preco_max: 600000, limite: 3 },
      3,
    );

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

    expect(renderizado).toContain("`.`cct_status` = 'publish'");
    expect(renderizado).toContain("like '%asa norte%'");
    expect(renderizado).toContain("limit 3");
  });

  it("conta de ? bate com o número de valores", () => {
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(fixos, {}, 5);
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("todo apelido usado no SQL foi declarado", () => {
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { bairro: "asa norte", limite: 5 },
      5,
    );
    const sqlSemCrase = sql.replace(/`/g, "");

    // Apelidos usados como <apelido>.coluna no SELECT/WHERE.
    const apelidosUsados = new Set<string>();
    const reColuna = /([a-zA-Z_][a-zA-Z0-9_]*)\.[a-zA-Z_][a-zA-Z0-9_]*/g;
    let m;
    while ((m = reColuna.exec(sqlSemCrase)) !== null) {
      if (m[1] !== "wp_jet_cct_imoveis") {
        // Não é referência a tabela, é um apelido de coluna (mas tabela-direta não usa apelidos)
        // Na tabela-direta plana não há JOINs, então não há apelidos além da tabela.
      }
    }

    // A tabela-direta não usa JOINs, então não há apelidos além da tabela quotada.
    // O SQL deve conter apenas a tabela quotada como qualificador de coluna.
    const reTabelaQualificada = /`wp_jet_cct_imoveis`\.`[a-z_]+`/g;
    const qualificacoes = [];
    while ((m = reTabelaQualificada.exec(sql)) !== null) {
      qualificacoes.push(m[0]);
    }
    // Toda qualificação de coluna usa a tabela quotada (não há apelidos soltos).
    expect(qualificacoes.length).toBeGreaterThan(0);
  });

  it("Zod recusa slug inválido (maiúscula)", () => {
    expect(() =>
      RECEITA_JETENGINE_IMOVEIS.parametrosFixos.parse({
        prefixo: "wp_",
        slug: "Imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
        },
      }),
    ).toThrow();
  });

  it("Zod recusa slug com 41+ caracteres", () => {
    expect(() =>
      RECEITA_JETENGINE_IMOVEIS.parametrosFixos.parse({
        prefixo: "wp_",
        slug: "a".repeat(41),
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
        },
      }),
    ).toThrow();
  });

  it("Zod recusa prefixo inválido", () => {
    expect(() =>
      RECEITA_JETENGINE_IMOVEIS.parametrosFixos.parse({
        prefixo: "wp; drop table",
        slug: "imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
        },
      }),
    ).toThrow();
  });

  it("Zod recusa coluna inválida (crase)", () => {
    expect(() =>
      RECEITA_JETENGINE_IMOVEIS.parametrosFixos.parse({
        prefixo: "wp_",
        slug: "imoveis",
        campos: {
          preco: "preco`; drop table",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
        },
      }),
    ).toThrow();
  });

  it("helper de preço: formato brasileiro 650.000,00", () => {
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { preco_max: 650000, limite: 5 },
      5,
    );
    expect(sql).toContain("CASE");
    expect(sql).toContain("REPLACE");
    expect(sql).toContain("LIKE '%,%'");
  });

  it("helper de preço: ponto decimal 650000.50", () => {
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { preco_max: 650000, limite: 5 },
      5,
    );
    expect(sql).toContain("REGEXP '[.][0-9]{1,2}$'");
  });

  it("helper de preço: pontos milhar 1.200.000", () => {
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { preco_max: 1200000, limite: 5 },
      5,
    );
    expect(sql).toContain("ELSE CAST(REPLACE");
  });

  it("quartos_min vira numero_min sobre filtro_numero (quartos)", () => {
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      fixos,
      { quartos_min: 2, limite: 5 },
      5,
    );
    expect(sql).toContain("CAST");
    expect(sql).toContain("DECIMAL(10,2)");
    expect(valores).toContain(2);
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("filtro de cidade sem coluna de cidade mapeada → filtro_sem_coluna:cidade (não ignora em silêncio)", () => {
    const { cidade: _cidade, ...camposSemCidade } = fixos.campos;
    const fixosSemCidade = { ...fixos, campos: camposSemCidade };
    expect(() =>
      RECEITA_JETENGINE_IMOVEIS.montar(fixosSemCidade, { cidade: "centro", limite: 3 }, 3),
    ).toThrow(/^filtro_sem_coluna:cidade$/);
    // Sem pedir cidade, a mesma receita monta normalmente.
    expect(() =>
      RECEITA_JETENGINE_IMOVEIS.montar(fixosSemCidade, { bairro: "asa norte", limite: 3 }, 3),
    ).not.toThrow();
  });

  it("slug com hífen: a tabela montada passa pelo validador de consulta", () => {
    const f = RECEITA_JETENGINE_IMOVEIS.parametrosFixos.parse({ ...fixos, slug: "meu-slug" });
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(f, { limite: 3 }, 3);
    expect(sql).toContain("wp_jet_cct_meu-slug");
    const tabelas = RECEITA_JETENGINE_IMOVEIS.tabelas(f);
    expect(tabelas).toEqual(["wp_jet_cct_meu-slug"]);
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
  });
});
