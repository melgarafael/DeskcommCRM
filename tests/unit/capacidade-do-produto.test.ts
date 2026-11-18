import { describe, expect, it } from "vitest";

import { corpoDaEdicao, rascunhoDaEdicao } from "@/lib/catalogo/edicao-do-produto";
import { lerPlanilha } from "@/lib/catalogo/planilha";
import { crmSearchProducts } from "@/lib/mcp/tools/comercio";
import type { McpContext } from "@/lib/mcp/types";
import { produtoCreateSchema, produtoPatchSchema, type Produto } from "@/lib/schemas/produtos";

/**
 * CAPACIDADE DO PRODUTO (#3472) — opcional, texto livre, até 60 caracteres, e
 * ligada por empresa em `settings.catalogo.capacidade`. Chega pelo formulário,
 * pela API, pela planilha e sai para o agente, que precisa responder "tem de
 * 256GB?" mesmo quando o nome não repete a capacidade. Desligada, a planilha
 * ignora a coluna e o agente não enxerga o valor guardado.
 */

const BASE = { codigo: "PRD-00001", nome: "iPhone 17 Pro Max", preco_cents: 999900 };

const PRODUTO: Produto = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "PRD-00001",
  nome: "iPhone 17 Pro Max",
  descricao: null,
  marca: "Apple",
  categoria: null,
  capacidade: "256GB",
  preco_cents: 999900,
  moeda: "BRL",
  custo_cents: null,
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
  origem: "manual",
  imagem_url: null,
  fotos: [],
  updated_at: "2026-10-26T12:00:00Z",
};

function ctxCom(produtos: Array<Record<string, unknown>>, capacidadeLigada = true): McpContext {
  const query = {
    select: () => query,
    eq: () => query,
    in: async () => ({ data: [], error: null }),
    limit: async () => ({ data: [], error: null }),
    order: () => query,
    range: async () => ({ data: produtos, error: null, count: produtos.length }),
    maybeSingle: async () => ({
      data: { settings: { catalogo: { capacidade: capacidadeLigada } } },
      error: null,
    }),
  };
  return {
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => query } as any,
  } as McpContext;
}

describe("capacidade — schema da API", () => {
  it("aceita e apara a capacidade", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, capacidade: " 256GB " });
    expect(r.success && r.data.capacidade).toBe("256GB");
  });

  it("é opcional: sem ela o produto entra igual", () => {
    const r = produtoCreateSchema.safeParse(BASE);
    expect(r.success).toBe(true);
    expect(r.success && "capacidade" in r.data).toBe(false);
  });

  it("recusa acima de 60 caracteres, na criação e no PATCH", () => {
    expect(produtoCreateSchema.safeParse({ ...BASE, capacidade: "x".repeat(61) }).success).toBe(false);
    expect(produtoPatchSchema.safeParse({ capacidade: "x".repeat(61) }).success).toBe(false);
    expect(produtoPatchSchema.safeParse({ capacidade: "x".repeat(60) }).success).toBe(true);
  });
});

describe("capacidade — edição pela tela", () => {
  const t = (s: string) => s;

  it("só manda a capacidade quando ela mudou, e limpar manda vazio", () => {
    const rascunho = rascunhoDaEdicao(PRODUTO);
    expect(rascunho.capacidade).toBe("256GB");
    expect(corpoDaEdicao(rascunho, PRODUTO, t)).toEqual({ corpo: {} });
    expect(corpoDaEdicao({ ...rascunho, capacidade: "512GB" }, PRODUTO, t)).toEqual({
      corpo: { capacidade: "512GB" },
    });
    expect(corpoDaEdicao({ ...rascunho, capacidade: "" }, PRODUTO, t)).toEqual({
      corpo: { capacidade: "" },
    });
  });
});

describe("capacidade — planilha", () => {
  const LIGADA = { capacidade: true };

  it("lê a coluna quando ela existe; célula vazia vira null", () => {
    const r = lerPlanilha("codigo,nome,preco,capacidade\nA,iPhone,10,256GB\nB,Capa,5,\n", undefined, LIGADA);
    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos.map((p) => p.capacidade)).toEqual(["256GB", null]);
  });

  it("sem a coluna, a chave some — reimportar planilha antiga não apaga a capacidade", () => {
    const r = lerPlanilha("codigo,nome,preco\nA,iPhone,10\n", undefined, LIGADA);
    if ("erro" in r) throw new Error(r.erro);
    expect("capacidade" in r.produtos[0]!).toBe(false);
  });

  it("desligada na empresa, a coluna é só uma coluna que não usei", () => {
    const r = lerPlanilha("codigo,nome,preco,capacidade\nA,iPhone,10,256GB\n");
    if ("erro" in r) throw new Error(r.erro);
    expect("capacidade" in r.produtos[0]!).toBe(false);
    expect(r.colunasIgnoradas).toEqual(["capacidade"]);
  });

  it("60 caracteres entram inteiros; 61 recusam a linha com o motivo, sem cortar", () => {
    const de60 = "x".repeat(60);
    const r = lerPlanilha(
      `codigo,nome,preco,capacidade\nA,iPhone,10,${de60}\nB,Capa,5,${de60}y\nC,Fone,7,1TB\n`,
      undefined,
      LIGADA,
    );
    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos.map((p) => [p.codigo, p.capacidade])).toEqual([
      ["A", de60],
      ["C", "1TB"],
    ]);
    expect(r.erros).toEqual([{ linha: 3, motivo: "capacidade com mais de 60 caracteres" }]);
  });
});

describe("capacidade — o agente enxerga", () => {
  it("devolve a capacidade e acha 256GB mesmo sem ela no nome", async () => {
    const outro = { ...PRODUTO, id: "55555555-5555-4555-8555-555555555555", capacidade: "512GB" };
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone 256gb", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO }, outro]),
    )) as { produtos: Array<{ capacidade?: string }> };

    expect(resultado.produtos.map((p) => p.capacidade)).toEqual(["256GB"]);
  });

  it("desligada na empresa, o valor guardado não pontua nem sai na resposta", async () => {
    const r = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO }], false),
    )) as { produtos: Array<Record<string, unknown>> };
    expect(r.produtos[0]).not.toHaveProperty("capacidade");

    const porCapacidade = (await crmSearchProducts.handler(
      { termo: "256gb", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO }], false),
    )) as { produtos: Array<Record<string, unknown>> };
    expect(porCapacidade.produtos).toEqual([]);
  });

  it("produto sem capacidade não ganha o campo", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO, capacidade: null }]),
    )) as { produtos: Array<Record<string, unknown>> };

    expect(resultado.produtos[0]).not.toHaveProperty("capacidade");
  });
});
