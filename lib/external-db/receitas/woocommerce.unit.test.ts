/**
 * Teste unitário da receita `woocommerce-produtos` SEM MySQL de verdade.
 *
 * Prova que o SQL montado pela receita:
 *  - filtra `post_type = 'product'` e `post_status = 'publish'` (rascunho nunca entra),
 *  - compara preço com `CAST(... AS DECIMAL(10,2))` (texto → número, jamais concatenação),
 *  - valida o prefixo com regex e nunca cola valor cru no SQL.
 *
 * Estes são exatamente os defeitos que o CI mediu em `tests/mysql/receita-woocommerce.test.ts`
 * (job `mysql-integracao`, que não roda aqui). Se alguém remover o filtro de `post_status`
 * ou a comparação por preço, este teste fica vermelho antes de chegar ao CI.
 */
import { describe, expect, it } from "vitest";

import { RECEITA_WOOCOMMERCE_PRODUTOS } from "./woocommerce";
import { validarConsultaDeReceita } from "./validador";

describe("receita woocommerce-produtos (unit, sem MySQL)", () => {
  const fixos = { prefixo: "wp_" };

  it("monta SQL com post_status = 'publish' (rascunho nunca aparece)", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(fixos, {}, 5);
    expect(sql).toContain("post_status = ?");
    expect(valores).toContain("publish");
    expect(sql).toContain("post_type = ?");
    expect(valores).toContain("product");
    const tabelas = RECEITA_WOOCOMMERCE_PRODUTOS.tabelas("wp_");
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
  });

  it("compara preço com CAST(... AS DECIMAL(10,2)) quando preco_max é passado", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      fixos,
      { preco_max: 60 },
      5,
    );
    expect(sql).toContain("CAST");
    expect(sql).toContain("DECIMAL(10,2)");
    expect(valores).toContain(60);
  });

  it("não concatena valor cru no SQL (sempre placeholder ?)", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      fixos,
      { busca: "camisa", preco_max: 60, so_em_estoque: true, limite: 3 },
      3,
    );
    // Nenhum valor aparece como texto no SQL.
    expect(sql).not.toContain("camisa");
    expect(sql).not.toContain("60");
    expect(sql).not.toContain("instock");
    expect(sql).not.toContain("publish");
    expect(sql).not.toContain("product");
    // Todo valor virou um placeholder `?`. A ordem dos valores espelha a ordem
    // dos `?` no texto: primeiro as quatro meta_key dos JOINs (que aparecem
    // antes do WHERE), depois as cláusulas do WHERE e por fim o LIMIT.
    expect(sql.split("?").length - 1).toBe(valores.length);
    expect(valores).toEqual([
      "_price",
      "_regular_price",
      "_sku",
      "_stock_status",
      "product",
      "publish",
      "%camisa%",
      "%camisa%",
      60,
      "instock",
      3,
    ]);
  });

  /**
   * Teste obrigatório do R-A: renderiza o SQL substituindo cada `?`, em
   * sequência, pelo valor correspondente de `valores`. Se a ordem dos valores
   * não casar com a ordem dos `?` no texto, a junção `mp.meta_key = ?`
   * receberia `"product"` em vez de `"_price"` e a consulta nunca devolvesse
   * nada (defeito real medido no CI).
   */
  it("placeholders estão alinhados com os valores na ordem do texto (R-A)", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      fixos,
      { busca: "camisa", preco_max: 60, so_em_estoque: true, limite: 3 },
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

    // O número de `?` bate com o número de valores.
    expect(sql.split("?").length - 1).toBe(valores.length);

    // Cada meta_key dos JOINs recebe o seu próprio valor (não "product").
    expect(renderizado).toContain("meta_key = '_price'");
    expect(renderizado).toContain("meta_key = '_regular_price'");
    expect(renderizado).toContain("meta_key = '_sku'");
    expect(renderizado).toContain("meta_key = '_stock_status'");

    // As cláusulas do WHERE recebem os valores de filtro.
    expect(renderizado).toContain("post_type = 'product'");
    expect(renderizado).toContain("post_status = 'publish'");
    expect(renderizado).toContain("limit 3");
  });

  it("prefixo inválido é recusado pelo Zod", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosFixos.parse({ prefixo: "wp; drop table" }),
    ).toThrow();
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosFixos.parse({ prefixo: "a".repeat(21) }),
    ).toThrow();
  });
});
