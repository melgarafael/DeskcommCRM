/**
 * Executor comercial (Entrega 5 do plano de concierge de compras Magento) —
 * `lib/commerce/cart.ts`. Cobre: criação idempotente de carrinho, reuso do
 * carrinho aberto, validação de external_id contra o cache (nunca confia no
 * modelo), replay de idempotência via ledger, quantidade absoluta em update,
 * e o link de recuperação (recusa sem módulo configurado).
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getOrCreateCart,
  addItems,
  updateItem,
  removeItem,
  createCheckoutLink,
  type CartExecutorContext,
} from "@/lib/commerce/cart";
import { MagentoSoapError } from "@/lib/magento/soap";
import type * as MagentoSoap from "@/lib/magento/soap";

vi.mock("@/lib/magento/soap", async () => {
  const actual = await vi.importActual<typeof MagentoSoap>("@/lib/magento/soap");
  return {
    ...actual,
    withMagentoSession: vi.fn(async (_config, fn: (sessionId: string) => Promise<unknown>) => fn("sid")),
    magentoCreateCart: vi.fn(async () => "999"),
    magentoCartAddItems: vi.fn(async () => true),
    magentoCartUpdateItems: vi.fn(async () => true),
    magentoCartRemoveItems: vi.fn(async () => true),
    magentoCartInfo: vi.fn(async () => ({
      quoteId: "999",
      isActive: true,
      itemsQty: 1,
      currency: "BRL",
      items: [{ itemId: "1", productId: "784", sku: "000018", name: "Sianinha", qty: 2, price: 19.9, rowTotal: 39.8 }],
    })),
    magentoCartTotals: vi.fn(async () => [
      { title: "Subtotal", amount: 39.8 },
      { title: "Grand Total", amount: 39.8 },
    ]),
  };
});

const soap = await import("@/lib/magento/soap");

type Row = Record<string, unknown>;

function makeTable(rows: Row[]) {
  interface State {
    filters: Array<[string, unknown, "eq" | "in"]>;
    mode: "select" | "insert" | "update";
    payload?: Row;
    single?: "single" | "maybeSingle";
  }
  function matches(state: State, row: Row): boolean {
    return state.filters.every(([k, v, kind]) => (kind === "in" ? (v as unknown[]).includes(row[k]) : row[k] === v));
  }
  function wrap(state: State, matched: Row[]) {
    if (state.single === "single") return { data: matched[0] ?? null, error: matched[0] ? null : { message: "not found" } };
    if (state.single === "maybeSingle") return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }
  function execute(state: State) {
    if (state.mode === "insert") {
      const row = { id: randomUUID(), ...state.payload };
      rows.push(row);
      return wrap(state, [row]);
    }
    if (state.mode === "update") {
      const affected = rows.filter((r) => matches(state, r));
      affected.forEach((r) => Object.assign(r, state.payload));
      return wrap(state, affected);
    }
    return wrap(state, rows.filter((r) => matches(state, r)));
  }
  function builder(state: State): unknown {
    return {
      select: () => builder(state),
      eq: (k: string, v: unknown) => builder({ ...state, filters: [...state.filters, [k, v, "eq"]] }),
      in: (k: string, v: unknown[]) => builder({ ...state, filters: [...state.filters, [k, v, "in"]] }),
      insert: (payload: Row) => builder({ ...state, mode: "insert", payload }),
      update: (payload: Row) => builder({ ...state, mode: "update", payload }),
      maybeSingle: () => builder({ ...state, single: "maybeSingle" }),
      single: () => builder({ ...state, single: "single" }),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        try {
          resolve(execute(state));
        } catch (err) {
          reject?.(err);
        }
      },
    };
  }
  return () => builder({ filters: [], mode: "select" });
}

function makeFakeAdmin(seed: { products?: string[]; carts?: Row[]; operations?: Row[] } = {}) {
  const cartsTable = makeTable(seed.carts ?? []);
  const opsTable = makeTable(seed.operations ?? []);
  const productsTable = makeTable(
    (seed.products ?? []).map((id) => ({ organization_id: "org-1", integration_id: "int-1", external_id: id, name: `Renda ${id}` })),
  );
  return {
    from: (table: string) => {
      if (table === "commerce_carts") return cartsTable();
      if (table === "commerce_operations") return opsTable();
      if (table === "commerce_products") return productsTable();
      throw new Error(`tabela inesperada no teste: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const CTX: CartExecutorContext = {
  organizationId: "org-1",
  integrationId: "int-1",
  conversationId: "conv-1",
  storeView: "default",
  config: { endpoint: "https://loja.example/index.php/api/v2_soap/", apiUser: "u", apiKey: "k" },
  jobId: "job-1",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("getOrCreateCart", () => {
  it("cria um quote novo quando não há carrinho aberto nesta conversa", async () => {
    const admin = makeFakeAdmin({ products: ["784"] });
    const cart = await getOrCreateCart(admin, CTX);
    expect(soap.magentoCreateCart).toHaveBeenCalledTimes(1);
    expect(cart.externalQuoteId).toBe("999");
    expect(cart.items).toEqual([
      { externalId: "784", sku: "000018", name: "Sianinha", qty: 2, priceCents: 1990, rowTotalCents: 3980 },
    ]);
    expect(cart.subtotalCents).toBe(3980);
    expect(cart.grandTotalCents).toBe(3980);
  });

  it("reusa o carrinho ABERTO existente da conversa, sem criar outro quote", async () => {
    const admin = makeFakeAdmin({
      products: ["784"],
      carts: [
        {
          id: "cart-1",
          organization_id: "org-1",
          integration_id: "int-1",
          conversation_id: "conv-1",
          status: "open",
          external_quote_id: "999",
        },
      ],
    });
    const cart = await getOrCreateCart(admin, CTX);
    expect(soap.magentoCreateCart).not.toHaveBeenCalled();
    expect(cart.cartId).toBe("cart-1");
  });
});

describe("addItems", () => {
  it("recusa produto fora do catálogo importado (nunca confia no external_id do modelo)", async () => {
    const admin = makeFakeAdmin({
      products: ["784"],
      carts: [{ id: "cart-1", organization_id: "org-1", integration_id: "int-1", conversation_id: "conv-1", status: "open", external_quote_id: "999" }],
    });
    await expect(addItems(admin, CTX, "cart-1", [{ externalId: "999999", qty: 1 }])).rejects.toMatchObject({
      code: "produto_nao_encontrado_no_catalogo",
    });
    expect(soap.magentoCartAddItems).not.toHaveBeenCalled();
  });

  it("inclui itens conhecidos e devolve o carrinho relido do Magento", async () => {
    const admin = makeFakeAdmin({
      products: ["784"],
      carts: [{ id: "cart-1", organization_id: "org-1", integration_id: "int-1", conversation_id: "conv-1", status: "open", external_quote_id: "999" }],
    });
    const cart = await addItems(admin, CTX, "cart-1", [{ externalId: "784", qty: 2 }]);
    expect(soap.magentoCartAddItems).toHaveBeenCalledWith(
      CTX.config,
      "sid",
      "999",
      [{ productId: "784", qty: 2 }],
      "default",
    );
    expect(cart.grandTotalCents).toBe(3980);
  });

  it("replay da mesma operação (mesmo job/carrinho/itens) não chama o Magento de novo", async () => {
    const admin = makeFakeAdmin({
      products: ["784"],
      carts: [{ id: "cart-1", organization_id: "org-1", integration_id: "int-1", conversation_id: "conv-1", status: "open", external_quote_id: "999" }],
    });
    await addItems(admin, CTX, "cart-1", [{ externalId: "784", qty: 2 }]);
    await addItems(admin, CTX, "cart-1", [{ externalId: "784", qty: 2 }]);
    expect(soap.magentoCartAddItems).toHaveBeenCalledTimes(1);
  });

  it("recusa carrinho que não está mais aberto", async () => {
    const admin = makeFakeAdmin({
      products: ["784"],
      carts: [{ id: "cart-1", organization_id: "org-1", integration_id: "int-1", conversation_id: "conv-1", status: "converted", external_quote_id: "999" }],
    });
    await expect(addItems(admin, CTX, "cart-1", [{ externalId: "784", qty: 1 }])).rejects.toMatchObject({
      code: "carrinho_nao_esta_aberto",
    });
  });
});

describe("addItems — inclusão parcial (o defeito de 20/09: 2 de 4 sem estoque derrubavam o lote)", () => {
  const cartRow = () => [
    { id: "cart-1", organization_id: "org-1", integration_id: "int-1", conversation_id: "conv-1", status: "open", external_quote_id: "999" },
  ];
  // clearAllMocks (afterEach do arquivo) limpa o histórico mas NÃO a implementação: sem isto, o
  // mockRejectedValue de um teste vaza para o seguinte.
  beforeEach(() => {
    vi.mocked(soap.magentoCartAddItems).mockReset().mockResolvedValue(true);
  });
  const semEstoque = () => new MagentoSoapError("Este produto está sem estoque no momento.", "soap_fault");
  const linhas = [
    { externalId: "784", qty: 1 },
    { externalId: "785", qty: 1 },
    { externalId: "786", qty: 1 },
  ];

  it("lote recusado → tenta item a item; entram os que a loja aceita e os recusados vêm nomeados", async () => {
    const admin = makeFakeAdmin({ products: ["784", "785", "786"], carts: cartRow() });
    vi.mocked(soap.magentoCartAddItems).mockImplementation(async (_c, _s, _q, lote) => {
      // o lote (3 linhas) é recusado inteiro, como o Magento faz; sozinha, só a 785 é recusada
      if (lote.length > 1 || lote[0]?.productId === "785") throw semEstoque();
      return true;
    });
    const res = await addItems(admin, CTX, "cart-1", linhas);
    expect(soap.magentoCartAddItems).toHaveBeenCalledTimes(4); // 1 lote + 3 individuais
    expect(res.refused).toEqual([
      { externalId: "785", name: "Renda 785", reason: "Este produto está sem estoque no momento." },
    ]);
    expect(res.cartId).toBe("cart-1"); // snapshot relido: o carrinho existe e reflete o que entrou
  });

  it("caminho feliz continua sendo UMA chamada e refused vazio", async () => {
    const admin = makeFakeAdmin({ products: ["784", "785"], carts: cartRow() });
    const res = await addItems(admin, CTX, "cart-1", linhas.slice(0, 2));
    expect(soap.magentoCartAddItems).toHaveBeenCalledTimes(1);
    expect(res.refused).toEqual([]);
  });

  it("a loja recusa TUDO → erro nenhum_item_incluido nomeando cada produto, ledger fica failed", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const admin = makeFakeAdmin({ products: ["784", "785"], carts: cartRow(), operations });
    vi.mocked(soap.magentoCartAddItems).mockRejectedValue(semEstoque());
    await expect(addItems(admin, CTX, "cart-1", linhas.slice(0, 2))).rejects.toMatchObject({
      code: "nenhum_item_incluido",
      message: expect.stringContaining("Renda 784"),
    });
    expect(operations.at(-1)).toMatchObject({ operation: "cart.add_items", status: "failed" });
  });

  it("UM item recusado não é tentado duas vezes", async () => {
    const admin = makeFakeAdmin({ products: ["785"], carts: cartRow() });
    vi.mocked(soap.magentoCartAddItems).mockRejectedValue(semEstoque());
    await expect(addItems(admin, CTX, "cart-1", [{ externalId: "785", qty: 1 }])).rejects.toMatchObject({
      code: "nenhum_item_incluido",
    });
    expect(soap.magentoCartAddItems).toHaveBeenCalledTimes(1);
  });

  it("falha de REDE não vira 'recusado': propaga e não repete item a item", async () => {
    const admin = makeFakeAdmin({ products: ["784", "785"], carts: cartRow() });
    vi.mocked(soap.magentoCartAddItems).mockRejectedValue(new MagentoSoapError("timeout", "network_error"));
    await expect(addItems(admin, CTX, "cart-1", linhas.slice(0, 2))).rejects.toMatchObject({ code: "network_error" });
    expect(soap.magentoCartAddItems).toHaveBeenCalledTimes(1);
  });
});

describe("updateItem / removeItem", () => {
  const carts = () => [
    { id: "cart-1", organization_id: "org-1", integration_id: "int-1", conversation_id: "conv-1", status: "open", external_quote_id: "999" },
  ];

  it("define quantidade ABSOLUTA (não incrementa)", async () => {
    const admin = makeFakeAdmin({ products: ["784"], carts: carts() });
    await updateItem(admin, CTX, "cart-1", "784", 5);
    expect(soap.magentoCartUpdateItems).toHaveBeenCalledWith(CTX.config, "sid", "999", [{ productId: "784", qty: 5 }], "default");
  });

  it("remove a linha pedida", async () => {
    const admin = makeFakeAdmin({ products: ["784"], carts: carts() });
    await removeItem(admin, CTX, "cart-1", "784");
    expect(soap.magentoCartRemoveItems).toHaveBeenCalledWith(CTX.config, "sid", "999", [{ productId: "784" }], "default");
  });
});

describe("createCheckoutLink", () => {
  const carts = () => [
    { id: "cart-1", organization_id: "org-1", integration_id: "int-1", conversation_id: "conv-1", status: "open", external_quote_id: "999" },
  ];

  it("recusa quando o módulo não está configurado", async () => {
    const admin = makeFakeAdmin({ carts: carts() });
    await expect(createCheckoutLink(admin, CTX, "cart-1", null)).rejects.toMatchObject({
      code: "modulo_nao_configurado",
    });
  });

  it("gera o link quando o secret está configurado", async () => {
    const admin = makeFakeAdmin({ carts: carts() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://loja.example/concierge/index/createLink");
        expect((init.headers as Record<string, string>)["X-Concierge-Secret"]).toBe("s3cret");
        return {
          ok: true,
          json: async () => ({ url: "https://loja.example/concierge/cart#abc", expires_at: "2026-09-07T00:00:00Z" }),
        };
      }),
    );
    const link = await createCheckoutLink(admin, CTX, "cart-1", "s3cret");
    expect(link.url).toBe("https://loja.example/concierge/cart#abc");
  });

  it("carrinho vazio confirmado → recusa sem chamar a loja (não gera link de quote vazio)", async () => {
    const admin = makeFakeAdmin({ carts: [{ ...carts()[0], items: [] }] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createCheckoutLink(admin, CTX, "cart-1", "s3cret")).rejects.toMatchObject({
      code: "carrinho_vazio",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deixa rastro no ledger quando gera o link (era a única operação sem rastro)", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const admin = makeFakeAdmin({ carts: carts(), operations });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ url: "https://loja.example/concierge/cart#abc", expires_at: "2026-09-21T00:00:00Z" }),
      })),
    );
    const link = await createCheckoutLink(admin, CTX, "cart-1", "s3cret");
    expect(link.expiresAt).toBe("2026-09-21T00:00:00Z");
    expect(operations.at(-1)).toMatchObject({ operation: "cart.checkout_link", status: "succeeded" });
  });

  it("deixa rastro no ledger quando FALHA — é a linha que faltava para diagnosticar o fechamento", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const admin = makeFakeAdmin({ carts: carts(), operations });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "secret inválido" })));
    await expect(createCheckoutLink(admin, CTX, "cart-1", "s3cret")).rejects.toMatchObject({
      code: "link_de_recuperacao_falhou",
    });
    expect(operations.at(-1)).toMatchObject({
      operation: "cart.checkout_link",
      status: "failed",
      result: { error: expect.stringContaining("401") },
    });
  });
});
