import { describe, expect, it } from "vitest";

import { RECEITA_WOOCOMMERCE_PRODUTOS, TETO_ITENS_WOOCOMMERCE } from "./woocommerce";
import { validarConsultaDeReceita } from "./validador";

describe("receita woocommerce-produtos", () => {
  it("monta SQL com placeholders ? — nunca concatena valor", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { termos: ["camisa"], preco_max: 200, so_em_estoque: true, limite: 3 },
      3,
    );
    // Todo valor é um placeholder ?; nunca texto cru no SQL.
    expect(sql).not.toContain("camisa");
    expect(sql).not.toContain("200");
    expect(sql).not.toContain("instock");
    // O prefixo aparece quotado com crase (identificador), nunca como valor de consulta.
    expect(sql).toContain("`wp_posts`");
    expect(valores).toContain("product");
    expect(valores).toContain("publish");
    expect(valores).toContain("%camisa%");
    expect(valores).toContain("camisa"); // o termo vira a coluna `termo`
    expect(valores).toContain(200);
    expect(valores).toContain("instock");
    expect(valores).toContain(3);
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("dois termos geram dois blocos union all (um por termo)", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { termos: ["camisetas", "sorvetes"], limite: 3 },
      3,
    );
    expect(sql).toContain("union all");
    expect(sql.split("union all").length - 1).toBe(1);
    // Cada bloco tem o seu limite e o seu termo.
    expect(valores).toContain("camisetas");
    expect(valores).toContain("sorvetes");
    expect(valores).toContain("%camiseta%");
    expect(valores).toContain("%sorvete%");
    expect(sql).not.toContain("%camisetasesorvetes%");
  });

  it("termo com duas palavras exige as duas no mesmo bloco (AND)", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { termos: ["camiseta preta"], limite: 3 },
      3,
    );
    // Duas palavras, cada uma gerando OR sobre 3 colunas → 6 blocos de OR.
    expect(sql.split(" and ").filter((c) => c.includes("like")).length).toBeGreaterThan(0);
    expect(valores).toContain("%camiseta%");
    expect(valores).toContain("%preta%");
  });

  it("o resumo (post_excerpt) entra na comparação", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { termos: ["cueca"], limite: 3 },
      3,
    );
    expect(sql).toContain("post_excerpt");
  });

  it("termos vazio é recusado pela validação", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({ termos: [] }),
    ).toThrow();
  });

  it("5 termos é recusado pela validação (máximo 4)", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({
        termos: ["a", "b", "c", "d", "e"],
      }),
    ).toThrow();
  });

  it("termo acima de 60 caracteres é recusado pela validação", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({
        termos: ["a".repeat(61)],
      }),
    ).toThrow();
  });

  it("texto malicioso num termo só aparece em valores, nunca no SQL", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { termos: ["x' or 1=1 --"], limite: 3 },
      3,
    );
    expect(sql).not.toContain("x' or 1=1 --");
    expect(sql).not.toContain("--");
    expect(valores).toContain("x' or 1=1 --");
  });

  it("prefixo válido entra quotado com crase", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar({ prefixo: "loja_" }, {}, 5);
    expect(sql).toContain("`loja_posts`");
    expect(sql).toContain("`loja_postmeta`");
  });

  it("rejeita prefixo inválido (Zod recusa)", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosFixos.parse({ prefixo: "wp; drop table" }),
    ).toThrow();
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosFixos.parse({ prefixo: "a".repeat(21) }),
    ).toThrow();
  });

  it("rejeita preço negativo (Zod recusa)", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({ preco_max: -1 }),
    ).toThrow();
  });

  it("rejeita limite acima do teto (Zod recusa)", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({ limite: TETO_ITENS_WOOCOMMERCE + 1 }),
    ).toThrow();
  });

  it("o SQL montado passa no validador com as tabelas permitidas", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar({ prefixo: "wp_" }, {}, 5);
    const tabelas = RECEITA_WOOCOMMERCE_PRODUTOS.tabelas({ prefixo: "wp_" });
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
  });

  it("o SQL com union all (vários termos) passa no validador — só SELECTs entre os blocos", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { termos: ["camisetas", "sorvetes"], limite: 3 },
      3,
    );
    const tabelas = RECEITA_WOOCOMMERCE_PRODUTOS.tabelas({ prefixo: "wp_" });
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
    expect(sql).toContain("union all");
  });

  it("sem termos → um bloco só, como antes", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar({ prefixo: "wp_" }, {}, 5);
    expect(sql).toMatch(/^select /i);
    expect(sql).not.toContain("union all");
    expect(valores).toContain("product");
    expect(valores).toContain("publish");
  });

  it("ordem: 'recentes' continua gerando desc sem termos", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { ordem: "recentes" },
      5,
    );
    expect(sql).toContain("order by `wp_posts`.ID desc ");
  });

  it("a descricao cita termos e o exemplo [\"camiseta\", \"sorvete\"]", () => {
    expect(RECEITA_WOOCOMMERCE_PRODUTOS.descricao).toContain("termos");
    expect(RECEITA_WOOCOMMERCE_PRODUTOS.descricao).toContain('["camiseta", "sorvete"]');
  });
});
