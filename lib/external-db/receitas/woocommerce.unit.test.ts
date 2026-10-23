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
      { termos: ["camisa"], preco_max: 60, so_em_estoque: true, limite: 3 },
      3,
    );
    // Nenhum valor aparece como texto no SQL.
    expect(sql).not.toContain("camisa");
    expect(sql).not.toContain("60");
    expect(sql).not.toContain("instock");
    expect(sql).not.toContain("publish");
    expect(sql).not.toContain("product");
    // Todo valor virou um placeholder `?`. A ordem dos valores espelha a ordem
    // dos `?` no texto: primeiro o termo (coluna `termo` no SELECT), depois as
    // quatro meta_key dos JOINs, depois as cláusulas do WHERE e por fim o LIMIT.
    expect(sql.split("?").length - 1).toBe(valores.length);
    expect(valores).toEqual([
      "camisa", // a coluna `termo`
      "_price",
      "_regular_price",
      "_sku",
      "_stock_status",
      "product",
      "publish",
      60,
      "instock",
      "%camisa%",
      "%camisa%",
      "%camisa%",
      3, // limite interno do bloco
      3, // limite total externo
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
      { termos: ["camisa"], preco_max: 60, so_em_estoque: true, limite: 3 },
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

  it("sem ordem o SQL termina com order by ID seguido de limit, sem desc", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(fixos, {}, 5);
    expect(sql).toContain("order by `wp_posts`.ID ");
    expect(sql).toContain(" limit ");
    expect(sql).not.toContain("desc");
  });

  it("ordem: 'recentes' acrescenta desc ao order by", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(fixos, { ordem: "recentes" }, 5);
    expect(sql).toContain("order by `wp_posts`.ID desc ");
    expect(sql).toContain(" limit ");
  });

  it("ordem invalido e rejeitado pela validacao do Zod", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({ ordem: "qualquer" }),
    ).toThrow();
  });

  it("descricao avisa o agente sobre ordem: \"recentes\"", () => {
    expect(RECEITA_WOOCOMMERCE_PRODUTOS.descricao).toContain("ordem: \"recentes\"");
  });

  it("termos: ['camisetas', 'sorvetes'] → dois blocos union all", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      fixos,
      { termos: ["camisetas", "sorvetes"], limite: 3 },
      3,
    );
    expect(sql).toContain("union all");
    expect(sql.split("union all").length - 1).toBe(1);
    // Cada termo aceita a forma sem o s final (plural).
    expect(valores).toContain("%camiseta%");
    expect(valores).toContain("%sorvete%");
    expect(sql).not.toContain("%camisetasesorvetes%");
  });

  it("termo com duas palavras exige as duas no mesmo bloco (AND)", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      fixos,
      { termos: ["camiseta preta"], limite: 3 },
      3,
    );
    expect(valores).toContain("%camiseta%");
    expect(valores).toContain("%preta%");
    // Duas palavras × 3 colunas = 6 blocos de OR, unidos por and entre as palavras.
    expect(sql).toContain("post_title");
    expect(sql).toContain("post_excerpt");
  });

  it("o resumo (post_excerpt) entra na comparação", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(fixos, { termos: ["cueca"], limite: 3 }, 3);
    expect(sql).toContain("post_excerpt");
  });

  it("termos: [] é recusado pela validação", () => {
    expect(() => RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({ termos: [] })).toThrow();
  });

  it("5 termos é recusado pela validação (máximo 4)", () => {
    expect(() =>
      RECEITA_WOOCOMMERCE_PRODUTOS.parametrosDaBusca.parse({ termos: ["a", "b", "c", "d", "e"] }),
    ).toThrow();
  });

  it("texto malicioso num termo só aparece em valores, nunca no SQL", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      fixos,
      { termos: ["x' or 1=1 --"], limite: 3 },
      3,
    );
    expect(sql).not.toContain("x' or 1=1 --");
    expect(sql).not.toContain("--");
    expect(valores).toContain("x' or 1=1 --");
  });

  it("sem termos → um bloco só, como antes", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(fixos, {}, 5);
    expect(sql).toMatch(/^select /i);
    expect(sql).not.toContain("union all");
    expect(valores).toContain("product");
    expect(valores).toContain("publish");
  });

  it("ordem: 'recentes' continua gerando desc sem termos", () => {
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(fixos, { ordem: "recentes" }, 5);
    expect(sql).toContain("order by `wp_posts`.ID desc ");
  });

  it("a descricao cita termos e o exemplo [\"camiseta\", \"sorvete\"]", () => {
    expect(RECEITA_WOOCOMMERCE_PRODUTOS.descricao).toContain("termos");
    expect(RECEITA_WOOCOMMERCE_PRODUTOS.descricao).toContain('["camiseta", "sorvete"]');
  });
});
