/**
 * `commerce_search_products` (Entrega 3 do plano de concierge de compras
 * Magento) contra o handler REAL, com `ctx.supabase` stub — mesmo padrão de
 * `mcp-governance-tools.test.ts`. Cobre: sucesso, isolamento cross-org
 * (organization_id só vem de `ctx`, nunca do input), busca vazia (aviso) e
 * input inválido.
 */
import { describe, expect, it } from "vitest";

import { commerceSearchProducts } from "@/lib/mcp/tools/comercio";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";

interface FakeRow {
  organization_id: string;
  external_id: string;
  sku: string;
  type: string;
  name: string;
  url_path: string | null;
  category_ids: unknown[];
  store_view: string;
  /** undefined/null = estoque desconhecido. */
  is_in_stock?: boolean | null;
}

function makeSupabase(rows: FakeRow[]) {
  const from = (table: string) => {
    expect(table).toBe("commerce_products");
    let orgFiltro: string | null = null;
    let orFiltro: string | null = null;
    let limite = 10;
    let semEstoqueFora = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: string) => {
        if (col === "organization_id") orgFiltro = val;
        return chain;
      },
      or: (expr: string) => {
        orFiltro = expr;
        return chain;
      },
      // `.not("is_in_stock", "is", false)` — o teste reproduz a semântica SQL: some só quem é false.
      not: (col: string, op: string, val: unknown) => {
        if (col === "is_in_stock" && op === "is" && val === false) semEstoqueFora = true;
        return chain;
      },
      limit: (n: number) => {
        limite = n;
        return chain;
      },
      then: (res: (v: unknown) => unknown) => {
        const termoMatch = orFiltro?.match(/name\.ilike\.%(.*?)%,sku/)?.[1] ?? "";
        const filtrado = rows
          .filter((r) => r.organization_id === orgFiltro)
          .filter((r) => !(semEstoqueFora && r.is_in_stock === false))
          .filter(
            (r) =>
              r.name.toLowerCase().includes(termoMatch.toLowerCase()) ||
              r.sku.toLowerCase().includes(termoMatch.toLowerCase()),
          )
          .slice(0, limite)
          .map(({ organization_id: _organizationId, is_in_stock: _stock, ...rest }) => rest);
        return Promise.resolve({ data: filtrado, error: null }).then(res);
      },
    };
    return chain;
  };
  return { from };
}

function makeCtx(rows: FakeRow[], organizationId = ORG): McpContext {
  return {
    organizationId,
    role: "agent",
    actor: { type: "ai_agent", id: "run_1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    supabase: makeSupabase(rows) as unknown as McpContext["supabase"],
  } as McpContext;
}

const PRODUTO: FakeRow = {
  organization_id: ORG,
  external_id: "784",
  sku: "000018",
  type: "simple",
  name: "SIANINHA 8MM 290 MARROM 50M",
  url_path: "sianinha-8mm.html",
  category_ids: [129, 142],
  store_view: "default",
};

type Resposta = { produtos: Array<{ external_id: string; sku: string }>; aviso?: string };

describe("commerce_search_products", () => {
  it("acha por parte do nome", async () => {
    const res = (await commerceSearchProducts.handler(
      { termo: "sianinha", limite: 10 },
      makeCtx([PRODUTO]),
    )) as Resposta;
    expect(res.produtos).toHaveLength(1);
    expect(res.produtos[0]?.sku).toBe("000018");
    expect(res).not.toHaveProperty("aviso");
  });

  it("acha por SKU", async () => {
    const res = (await commerceSearchProducts.handler(
      { termo: "000018", limite: 10 },
      makeCtx([PRODUTO]),
    )) as Resposta;
    expect(res.produtos).toHaveLength(1);
  });

  it("não vaza produto de outra organização", async () => {
    const res = (await commerceSearchProducts.handler(
      { termo: "sianinha", limite: 10 },
      makeCtx([PRODUTO], OUTRA_ORG),
    )) as Resposta;
    expect(res.produtos).toHaveLength(0);
    expect(res.aviso).toBe("nada com esse nome/SKU no catálogo importado");
  });

  it("busca vazia devolve aviso, não erro", async () => {
    const res = (await commerceSearchProducts.handler(
      { termo: "inexistente", limite: 10 },
      makeCtx([PRODUTO]),
    )) as Resposta;
    expect(res.produtos).toHaveLength(0);
    expect(res.aviso).toBeDefined();
  });

  it("não oferece produto que a loja marcou sem estoque", async () => {
    const semEstoque: FakeRow = { ...PRODUTO, external_id: "785", sku: "000019", is_in_stock: false };
    const res = (await commerceSearchProducts.handler(
      { termo: "sianinha", limite: 10 },
      makeCtx([semEstoque, PRODUTO]),
    )) as Resposta;
    expect(res.produtos.map((p) => p.external_id)).toEqual(["784"]);
  });

  it("estoque desconhecido (NULL) segue ofertável — a trava real é present_product", async () => {
    const desconhecido: FakeRow = { ...PRODUTO, is_in_stock: null };
    const emEstoque: FakeRow = { ...PRODUTO, external_id: "786", is_in_stock: true };
    const res = (await commerceSearchProducts.handler(
      { termo: "sianinha", limite: 10 },
      makeCtx([desconhecido, emEstoque]),
    )) as Resposta;
    expect(res.produtos).toHaveLength(2);
  });

  it("recusa termo curto demais (Zod)", () => {
    expect(() => commerceSearchProducts.inputSchema.termo.parse("a")).toThrow();
  });
});
