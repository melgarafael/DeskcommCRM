import { describe, expect, it } from "vitest";

import { formatProductForRag, type NuvemshopProduct } from "./format-product";

// O formato que a API de produtos da Nuvemshop devolve: nome e descrição por
// idioma da loja, preço e SKU nas variantes.
const daApi: NuvemshopProduct = {
  id: "378140699",
  name: { pt: "Camiseta Básica Algodão" },
  description: { pt: "<p>Malha <strong>100%</strong> algodão.</p>" },
  variants: [{ price: "59.90", sku: "DEMO-001" }],
  categories: [{ name: { pt: "Camisetas" } }],
  permalink: "https://loja.exemplo/produtos/camiseta",
};

describe("formatProductForRag — produto como a Nuvemshop manda", () => {
  it("lê a descrição por idioma e tira o HTML", () => {
    const texto = formatProductForRag(daApi);
    expect(texto).toContain("Produto: Camiseta Básica Algodão");
    expect(texto).toContain("Descrição: Malha 100% algodão.");
    expect(texto).toContain("Preço: R$ 59.90, SKU: DEMO-001");
    expect(texto).toContain("Categorias: Camisetas");
  });

  it("produto sem descrição (o idioma vem vazio) não quebra a fonte inteira", () => {
    const texto = formatProductForRag({ ...daApi, description: { pt: "" } });
    expect(texto).toContain("Descrição: N/A");
  });

  it("descrição nula vira N/A", () => {
    expect(formatProductForRag({ ...daApi, description: null })).toContain("Descrição: N/A");
  });

  it("loja só em espanhol usa o idioma que existe", () => {
    const texto = formatProductForRag({
      ...daApi,
      name: { es: "Camiseta Básica" },
      description: { es: "Algodón" },
    });
    expect(texto).toContain("Produto: Camiseta Básica");
    expect(texto).toContain("Descrição: Algodón");
  });

  it("texto puro continua aceito", () => {
    const texto = formatProductForRag({ ...daApi, name: "Boné", description: "<b>Aba curva</b>" });
    expect(texto).toContain("Produto: Boné");
    expect(texto).toContain("Descrição: Aba curva");
  });
});
