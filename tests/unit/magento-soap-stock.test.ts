/**
 * `catalogInventoryStockItemList`: o formato do request é travado contra o WSDL da loja.
 *
 * `magentoGetStock` foi escrita na Entrega 3 e nunca chamada — e mandava
 * `<products><products>sku</products></products>`. O WSDL real (`.context/magento-v2.wsdl`) diz
 * `productIds: ArrayOfString`, e `ArrayOfString` é uma sequência de `complexObjectArray`. Medido
 * contra a loja: o formato antigo não seria aceito; o novo devolveu 425 linhas para 500 ids.
 */
import { describe, expect, it } from "vitest";

import { buildStockItemListEnvelope } from "@/lib/magento/soap";

describe("buildStockItemListEnvelope", () => {
  const xml = buildStockItemListEnvelope("sess-1", ["963", "961"]);

  it("usa o parâmetro `productIds` do WSDL — não `products`", () => {
    expect(xml).toContain("<productIds>");
    expect(xml).not.toContain("<products>");
  });

  it("cada id vai em <complexObjectArray>, um por id, sem aninhar o nome do parâmetro", () => {
    expect(xml).toContain("<productIds><complexObjectArray>963</complexObjectArray><complexObjectArray>961</complexObjectArray></productIds>");
  });

  it("carrega o sessionId e o wrapper RequestParam do método", () => {
    expect(xml).toContain("<sessionId>sess-1</sessionId>");
    expect(xml).toContain("catalogInventoryStockItemListRequestParam");
  });

  it("escapa XML nos valores (SKU pode ter & ou <)", () => {
    expect(buildStockItemListEnvelope("s", ["A&B<1>"])).toContain("A&amp;B&lt;1&gt;");
  });
});
