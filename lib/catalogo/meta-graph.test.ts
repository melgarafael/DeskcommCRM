import { describe, expect, it } from "vitest";

import {
  CAMPOS_EXTRAS,
  campoRecusadoPelaMeta,
  htmlParaTexto,
  juntarFotos,
  mapearProdutoDaMeta,
  precoDaMeta,
} from "./meta-graph";

describe("htmlParaTexto — a formatação volta", () => {
  it("parágrafo e <br> viram quebra de linha, sem grudar palavras", () => {
    const html = "<p>Quadriciclo Elétrico – Laranja e Rosa</p><p>O Quadriciclo é perfeito.<br>Bateria de 24V.</p>";
    expect(htmlParaTexto(html)).toBe("Quadriciclo Elétrico – Laranja e Rosa\n\nO Quadriciclo é perfeito.\nBateria de 24V.");
  });

  it("lista vira bullets, um por linha", () => {
    const html = "<p>Especificações:</p><ul><li>Marca: Importway</li><li>Modelo: BW232</li></ul>";
    expect(htmlParaTexto(html)).toBe("Especificações:\n\n• Marca: Importway\n• Modelo: BW232");
  });

  it("entidades e espaços sobrando", () => {
    expect(htmlParaTexto("<b>Preço&nbsp;&amp; frete</b> &#8226; 3&nbsp;anos")).toBe("Preço & frete • 3 anos");
  });
});

describe("precoDaMeta", () => {
  it("lê os formatos que a Graph devolve", () => {
    expect(precoDaMeta("R$1.234,56")).toBe(123456);
    expect(precoDaMeta("199.90 BRL")).toBe(19990);
    expect(precoDaMeta(null)).toBeNull();
  });
});

describe("mapearProdutoDaMeta", () => {
  const base = { id: "1", retailer_id: "BW398", name: "Quadriciclo", price: "R$2.999,00", image_url: "https://cdn/1.jpg" };

  it("descrição formatada vence a pura; a pura é a reserva", () => {
    expect(
      mapearProdutoDaMeta({ ...base, description: "LinhaUmLinhaDois", rich_text_description: "<p>Linha um</p><p>Linha dois</p>" })
        ?.descricao,
    ).toBe("Linha um\n\nLinha dois");
    // A pura é reformatada (`formatar-descricao.ts`): ganha o emoji do tipo do produto.
    expect(mapearProdutoDaMeta({ ...base, description: "só a pura" })?.descricao).toBe("🏎️ só a pura");
  });

  it("todas as fotos, sem repetir, até 5", () => {
    const p = mapearProdutoDaMeta({
      ...base,
      additional_image_urls: ["https://cdn/2.jpg", "https://cdn/1.jpg", "https://cdn/3.jpg"],
      images: [{ url: "https://cdn/4.jpg" }, "https://cdn/5.jpg", "https://cdn/6.jpg"],
    });
    expect(p?.fotos).toEqual(["https://cdn/1.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg", "https://cdn/4.jpg", "https://cdn/5.jpg"]);
    expect(p?.imagem_url).toBe("https://cdn/1.jpg");
  });

  it("vídeo, link, GTIN, categoria e peso", () => {
    const p = mapearProdutoDaMeta({
      ...base,
      videos_metadata: [{ video_url: "https://cdn/v.mp4" }],
      url: "https://loja/bw398",
      gtin: "7890000000000",
      product_type: "Brinquedos > Elétricos",
      shipping_weight_value: "18.5",
      shipping_weight_unit: "kg",
    });
    expect(p).toMatchObject({
      video_url: "https://cdn/v.mp4",
      link_loja: "https://loja/bw398",
      gtin: "7890000000000",
      categoria: "Brinquedos > Elétricos",
      peso_gramas: 18500,
    });
  });

  it("promoção vira o par de/por", () => {
    const p = mapearProdutoDaMeta({ ...base, sale_price: "R$2.499,00" });
    expect(p).toMatchObject({ preco_cents: 249900, preco_de_cents: 299900 });
    expect(mapearProdutoDaMeta(base)).toMatchObject({ preco_cents: 299900, preco_de_cents: null });
  });

  it("estoque da Meta quando existe; disponibilidade quando não", () => {
    expect(mapearProdutoDaMeta({ ...base, inventory: 7 })?.quantidade).toBe(7);
    expect(mapearProdutoDaMeta({ ...base, availability: "out of stock" })?.quantidade).toBe(0);
    expect(mapearProdutoDaMeta({ ...base, availability: "in stock" })?.quantidade).toBe(999);
  });
});

describe("juntarFotos — reimportar não perde foto", () => {
  it("as atuais ficam na frente, as da Meta completam", () => {
    expect(juntarFotos(["org/p/a.jpg"], ["https://cdn/1.jpg", "https://cdn/2.jpg"])).toEqual([
      "org/p/a.jpg",
      "https://cdn/1.jpg",
      "https://cdn/2.jpg",
    ]);
  });
});

describe("campoRecusadoPelaMeta", () => {
  it("acha o campo extra recusado; erro de catálogo não é campo", () => {
    expect(
      campoRecusadoPelaMeta("(#100) Tried accessing nonexisting field (videos_metadata) on node type (ProductItem)", CAMPOS_EXTRAS),
    ).toBe("videos_metadata");
    expect(campoRecusadoPelaMeta("(#100) Tried accessing nonexisting field (products) on node type (Page)", CAMPOS_EXTRAS)).toBeNull();
    expect(campoRecusadoPelaMeta("Error validating application. Application has been deleted.", CAMPOS_EXTRAS)).toBeNull();
  });
});
