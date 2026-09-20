/**
 * `presentProduct` (Entrega 4 do plano de concierge de compras Magento) —
 * confirma ao vivo, baixa a imagem principal e sobe no Storage. Cobre:
 * sucesso, produto fora do cache (nunca confia em external_id do modelo),
 * produto desabilitado ao vivo, sem imagem, download falho.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { presentProduct, PresentProductError } from "@/lib/commerce/present-product";
import type * as MagentoSoap from "@/lib/magento/soap";

const ORG = "22222222-2222-4222-8222-222222222222";
const INTEGRATION = "33333333-3333-4333-8333-333333333333";
const CONFIG = { endpoint: "https://loja.example/index.php/api/v2_soap/", apiUser: "u", apiKey: "k" };

vi.mock("@/lib/magento/soap", async () => {
  const actual = await vi.importActual<typeof MagentoSoap>("@/lib/magento/soap");
  return {
    ...actual,
    withMagentoSession: vi.fn(async (_config, fn: (sessionId: string) => Promise<unknown>) => fn("sid")),
    magentoGetProduct: vi.fn(),
    magentoGetProductImages: vi.fn(),
    magentoGetStock: vi.fn(),
  };
});

const soap = await import("@/lib/magento/soap");

const EM_ESTOQUE = [{ productId: "784", sku: "000018", qty: "10.0000", isInStock: true }];

function makeAdmin(opts: {
  cachedRow?: { name: string; url_path: string | null } | null;
  uploadError?: { message: string } | null;
}) {
  const fake = {
    from: (table: string) => {
      expect(table).toBe("commerce_products");
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.cachedRow ?? null }),
              }),
            }),
          }),
        }),
      };
    },
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("whatsapp-media");
        return {
          upload: async () => ({ error: opts.uploadError ?? null }),
        };
      },
    },
  };
  return fake as unknown as Parameters<typeof presentProduct>[0];
}

const INPUT_BASE = {
  organizationId: ORG,
  integrationId: INTEGRATION,
  conversationId: "44444444-4444-4444-8444-444444444444",
  storeView: "default",
  config: CONFIG,
  externalId: "784",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("presentProduct", () => {
  it("recusa produto que não está no cache (nunca confia no external_id do modelo)", async () => {
    const admin = makeAdmin({ cachedRow: null });
    await expect(presentProduct(admin, INPUT_BASE)).rejects.toMatchObject({
      code: "produto_nao_encontrado_no_catalogo",
    });
  });

  it("recusa produto desabilitado ao vivo, mesmo com cache OK", async () => {
    const admin = makeAdmin({ cachedRow: { name: "Sianinha", url_path: "sianinha.html" } });
    vi.mocked(soap.magentoGetProduct).mockResolvedValue({
      productId: "784",
      sku: "000018",
      type: "simple",
      name: "Sianinha",
      price: "19.90",
      status: "2", // desabilitado
      visibility: "4",
      urlPath: "sianinha.html",
      description: null,
      shortDescription: null,
    });
    await expect(presentProduct(admin, INPUT_BASE)).rejects.toMatchObject({
      code: "produto_indisponivel",
    });
  });

  it("recusa produto habilitado mas SEM ESTOQUE ao vivo — o defeito de 20/09 (2 de 4 rendas)", async () => {
    const admin = makeAdmin({ cachedRow: { name: "Renda", url_path: "renda.html" } });
    vi.mocked(soap.magentoGetProduct).mockResolvedValue({
      productId: "784", sku: "000018", type: "simple", name: "Renda", price: "19.90",
      status: "1", // habilitado — e mesmo assim não dá para vender
      visibility: "4", urlPath: "renda.html", description: null, shortDescription: null,
    });
    // a loja real devolve qty>0 com is_in_stock=0: vendabilidade é is_in_stock, não qty
    vi.mocked(soap.magentoGetStock).mockResolvedValue([
      { productId: "784", sku: "000018", qty: "2.0000", isInStock: false },
    ]);
    await expect(presentProduct(admin, INPUT_BASE)).rejects.toMatchObject({
      code: "produto_sem_estoque",
    });
    // recusou ANTES de baixar/subir imagem
    expect(soap.magentoGetProductImages).not.toHaveBeenCalled();
  });

  it("consulta de estoque que FALHA não derruba a apresentação (só recusa quando a loja confirma)", async () => {
    const admin = makeAdmin({ cachedRow: { name: "Renda", url_path: "renda.html" } });
    vi.mocked(soap.magentoGetProduct).mockResolvedValue({
      productId: "784", sku: "000018", type: "simple", name: "Renda", price: "19.90",
      status: "1", visibility: "4", urlPath: "renda.html", description: null, shortDescription: null,
    });
    vi.mocked(soap.magentoGetStock).mockRejectedValue(new Error("timeout"));
    vi.mocked(soap.magentoGetProductImages).mockResolvedValue([]);
    // chega até a etapa da imagem, prova de que passou pelo estoque
    await expect(presentProduct(admin, INPUT_BASE)).rejects.toMatchObject({ code: "produto_sem_imagem" });
  });

  it("recusa produto sem imagem", async () => {
    const admin = makeAdmin({ cachedRow: { name: "Sianinha", url_path: "sianinha.html" } });
    vi.mocked(soap.magentoGetProduct).mockResolvedValue({
      productId: "784",
      sku: "000018",
      type: "simple",
      name: "Sianinha",
      price: "19.90",
      status: "1",
      visibility: "4",
      urlPath: "sianinha.html",
      description: null,
      shortDescription: null,
    });
    vi.mocked(soap.magentoGetProductImages).mockResolvedValue([]);
    await expect(presentProduct(admin, INPUT_BASE)).rejects.toMatchObject({
      code: "produto_sem_imagem",
    });
  });

  it("baixa a imagem, sobe no Storage e devolve preço/URL corretos", async () => {
    const admin = makeAdmin({ cachedRow: { name: "Sianinha", url_path: "sianinha.html" } });
    vi.mocked(soap.magentoGetProduct).mockResolvedValue({
      productId: "784",
      sku: "000018",
      type: "simple",
      name: "Sianinha",
      price: "19.90",
      status: "1",
      visibility: "4",
      urlPath: "sianinha.html",
      description: null,
      shortDescription: null,
    });
    vi.mocked(soap.magentoGetProductImages).mockResolvedValue([
      { url: "https://loja.example/media/catalog/product/s/i/sianinha.jpg", label: null, position: "1", types: ["image"] },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    );

    const result = await presentProduct(admin, INPUT_BASE);
    expect(result.mime).toBe("image/jpeg");
    expect(result.priceCents).toBe(1990);
    expect(result.productUrl).toBe("https://loja.example/sianinha.html");
    expect(result.productName).toBe("Sianinha");
    expect(result.storagePath).toContain(`${ORG}/${INPUT_BASE.conversationId}/commerce/784-`);
  });

  it("propaga falha de download como erro de ensino", async () => {
    const admin = makeAdmin({ cachedRow: { name: "Sianinha", url_path: "sianinha.html" } });
    vi.mocked(soap.magentoGetProduct).mockResolvedValue({
      productId: "784",
      sku: "000018",
      type: "simple",
      name: "Sianinha",
      price: "19.90",
      status: "1",
      visibility: "4",
      urlPath: "sianinha.html",
      description: null,
      shortDescription: null,
    });
    vi.mocked(soap.magentoGetProductImages).mockResolvedValue([
      { url: "https://loja.example/media/catalog/product/s/i/sianinha.jpg", label: null, position: "1", types: ["image"] },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    await expect(presentProduct(admin, INPUT_BASE)).rejects.toBeInstanceOf(PresentProductError);
  });
});
