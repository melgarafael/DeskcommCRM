/**
 * R4 da Spec 25: as receitas devolvem `imagem_url` (opcional). Sem MySQL: prova
 * o SQL montado (o comportamento contra dados reais está em `tests/mysql/*`).
 */
import { describe, expect, it } from "vitest";

import { RECEITA_ACF_IMOVEIS } from "./acf-imoveis";
import { RECEITA_JETENGINE_IMOVEIS } from "./jetengine-imoveis";
import { RECEITA_TABELA_DIRETA } from "./tabela-direta";
import { validarConsultaDeReceita } from "./validador";
import { RECEITA_WOOCOMMERCE_PRODUTOS } from "./woocommerce";

/** Substitui cada `?` pelo valor, na ordem — se desalinhar, o valor errado aparece no lugar. */
function renderizar(sql: string, valores: unknown[]): string {
  const partes = sql.split("?");
  expect(partes.length - 1).toBe(valores.length);
  return partes.map((p, i) => p + (i < valores.length ? JSON.stringify(valores[i]) : "")).join("");
}

describe("imagem_url nas receitas WordPress (woocommerce e acf-imoveis)", () => {
  const acf = {
    prefixo: "wp_",
    post_type: "imovel",
    campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
  };

  it.each([
    ["woocommerce", () => RECEITA_WOOCOMMERCE_PRODUTOS.montar({ prefixo: "wp_" }, {}, 5), RECEITA_WOOCOMMERCE_PRODUTOS.tabelas({ prefixo: "wp_" })],
    ["acf-imoveis", () => RECEITA_ACF_IMOVEIS.montar(acf, {}, 5), RECEITA_ACF_IMOVEIS.tabelas(acf)],
  ])("%s: LEFT JOIN no anexo da imagem destacada, _thumbnail_id por placeholder", (_nome, montar, tabelas) => {
    const { sql, valores } = montar();
    // LEFT JOIN: item sem foto continua aparecendo, com imagem_url nulo.
    expect(sql).toMatch(/left join `wp_postmeta` `mthumb` on/i);
    expect(sql).toMatch(/left join `wp_posts` `matt` on `matt`\.ID = CAST\(`mthumb`\.meta_value AS UNSIGNED\)/);
    expect(sql).toContain("`matt`.guid as imagem_url");
    // meta_key e post_type do anexo são VALORES, nunca texto do SQL.
    expect(sql).not.toContain("_thumbnail_id");
    expect(sql).not.toContain("attachment");
    expect(valores).toContain("_thumbnail_id");
    expect(valores).toContain("attachment");
    const renderizado = renderizar(sql, valores);
    expect(renderizado).toContain("`mthumb`.meta_key = \"_thumbnail_id\"");
    expect(renderizado).toContain("`matt`.post_type = \"attachment\"");
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
  });

  it("todo apelido novo usado foi declarado numa junção", () => {
    const { sql } = RECEITA_ACF_IMOVEIS.montar(acf, { bairro: "x" }, 5);
    const s = sql.replace(/`/g, "");
    for (const apelido of ["mthumb", "matt"]) {
      expect(s, apelido).toMatch(new RegExp(String.raw`(postmeta|posts)\s+${apelido}\s+on`));
    }
  });

  it("as colunas liberadas cobrem o que o JOIN do anexo lê", () => {
    const cols = RECEITA_WOOCOMMERCE_PRODUTOS.colunas({ prefixo: "wp_" });
    expect(cols["wp_posts"]).toEqual(expect.arrayContaining(["ID", "guid", "post_type"]));
    expect(cols["wp_postmeta"]).toEqual(expect.arrayContaining(["post_id", "meta_key", "meta_value"]));
  });
});

describe("imagem_url na tabela-direta (colunas.imagem)", () => {
  const base = { id: "id", titulo: "modelo", filtros_texto: [], exibir: [] as string[] };

  it("com colunas.imagem, devolve a coluna como imagem_url", () => {
    const fixos = { tabela: "carros", colunas: { ...base, imagem: "foto" } };
    const parsed = RECEITA_TABELA_DIRETA.parametrosFixos.parse(fixos);
    const { sql } = RECEITA_TABELA_DIRETA.montar(parsed, {}, 5);
    expect(sql).toContain("`carros`.`foto` as imagem_url");
    expect(RECEITA_TABELA_DIRETA.colunas(parsed)["carros"]).toContain("foto");
  });

  it("sem colunas.imagem, não há imagem_url", () => {
    const fixos = { tabela: "carros", colunas: base };
    const { sql } = RECEITA_TABELA_DIRETA.montar(fixos, {}, 5);
    expect(sql).not.toContain("imagem_url");
  });

  it("recusa exibir chamado imagem_url (colidiria com o apelido) e coluna repetida", () => {
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({ tabela: "t", colunas: { ...base, exibir: ["imagem_url"] } }),
    ).toThrow();
    expect(() =>
      RECEITA_TABELA_DIRETA.parametrosFixos.parse({ tabela: "t", colunas: { ...base, imagem: "modelo" } }),
    ).toThrow();
  });
});

describe("imagem_url no jetengine-imoveis (campos.imagem)", () => {
  const campos = { preco: "preco", quartos: "quartos", bairro: "bairro", titulo: "titulo" };

  it("sem campos.imagem: nada de posts, nada de imagem_url", () => {
    const fixos = { prefixo: "wp_", slug: "imoveis", campos };
    const { sql } = RECEITA_JETENGINE_IMOVEIS.montar(fixos, {}, 5);
    expect(sql).not.toContain("imagem_url");
    expect(RECEITA_JETENGINE_IMOVEIS.tabelas(fixos)).toEqual(["wp_jet_cct_imoveis"]);
  });

  it("com campos.imagem: URL direta ou, se só dígitos, guid do anexo (INFERIDO)", () => {
    const fixos = { prefixo: "wp_", slug: "imoveis", campos: { ...campos, imagem: "foto" } };
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(fixos, { bairro: "centro" }, 5);
    expect(sql).toContain("regexp '^[0-9]+$'");
    expect(sql).toContain("left join `wp_posts` `matt`");
    expect(sql).toMatch(/as imagem_url/);
    // O 'attachment' do JOIN vem ANTES dos valores do WHERE.
    expect(valores).toEqual(["attachment", "publish", "%centro%", 5]);
    const tabelas = RECEITA_JETENGINE_IMOVEIS.tabelas(fixos);
    expect(tabelas).toEqual(["wp_jet_cct_imoveis", "wp_posts"]);
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
    const cols = RECEITA_JETENGINE_IMOVEIS.colunas(fixos);
    expect(cols["wp_jet_cct_imoveis"]).toContain("foto");
    expect(cols["wp_posts"]).toEqual(expect.arrayContaining(["ID", "guid", "post_type"]));
  });
});
