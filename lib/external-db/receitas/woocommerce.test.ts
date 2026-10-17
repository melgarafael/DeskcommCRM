import { describe, expect, it } from "vitest";

import { RECEITA_WOOCOMMERCE_PRODUTOS, TETO_ITENS_WOOCOMMERCE } from "./woocommerce";
import { validarConsultaDeReceita } from "./validador";

describe("receita woocommerce-produtos", () => {
  it("monta SQL com placeholders ? — nunca concatena valor", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: "wp_" },
      { busca: "camisa", preco_max: 200, so_em_estoque: true, limite: 3 },
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
    expect(valores).toContain(200);
    expect(valores).toContain("instock");
    expect(valores).toContain(3);
    expect(sql.split("?").length - 1).toBe(valores.length);
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

  it("rejeita busca acima de 80 caracteres (Zod recusa)", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({ busca: "a".repeat(81) }),
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
    const tabelas = RECEITA_WOOCOMMERCE_PRODUTOS.tabelas("wp_");
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
  });

  it("busca sem parâmetros ainda monta SELECT válido", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar({ prefixo: "wp_" }, {}, 5);
    expect(sql).toMatch(/^select /i);
    expect(valores).toContain("product");
    expect(valores).toContain("publish");
  });
});
