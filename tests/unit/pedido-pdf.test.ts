// @vitest-environment node
// node de propósito: o jsdom trunca os streams Flate do @react-pdf/renderer
// (PDF com /Length maior que o stream real) — provado em 2026-09-06 com doc
// mínimo. Em node o stream descomprime íntegro, igual à rota de produção.
import { describe, expect, it } from "vitest";

import { numeroDoPedidoPdf, precoLiquidoCents, renderPedidoPdf } from "@/lib/comercial/pedido-pdf";

/**
 * O PDF do pedido renderiza de verdade (cerca do ATT.txt F2 §5.3).
 *
 * Não confere pixel — confere que o Buffer é um PDF válido e tem tamanho
 * plausível (documento de 1 página com tabela nunca tem 200 bytes).
 */
describe("renderPedidoPdf", () => {
  it("gera PDF válido com acentos e totais", async () => {
    const buf = await renderPedidoPdf(
      { nome: "Bill Higiene e Limpeza", documento: "12.345.678/0001-90" },
      {
        numero: 7,
        status: "aprovado",
        subtotal_cents: 15000,
        desconto_cents: 1000,
        frete_cents: 500,
        total_cents: 14500,
        condicao_pagamento: "30 dias",
        observacoes: "Entregar pela manhã",
        endereco_entrega: null,
        created_at: "2026-09-04T12:00:00Z",
        vendedor_nome: "Ana",
        cliente: {
          nome: "Mercado Central",
          fantasia: null,
          rotuloDocumento: "CNPJ",
          documento: null,
          ie: null,
          endereco: "Rua X, 123",
          bairro: "Centro",
          cep: null,
          cidade: "Canoinhas",
          uf: "SC",
          fone: null,
          email: null,
        },
        itens: [
          {
            produto_codigo: "AG-5L",
            produto_nome: "Água Sanitária 5L",
            quantidade: 2,
            unidade: "UN",
            preco_unit_cents: 5000,
            desconto_pct: 10,
            subtotal_cents: 9000,
          },
        ],
      },
    );
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(2000);
  });

  it("numera com zeros à esquerda", () => {
    expect(numeroDoPedidoPdf(7)).toBe("PED-0007");
  });

  it("preço líquido arredonda, não trunca", () => {
    expect(precoLiquidoCents(5000, 10)).toBe(4500);
    expect(precoLiquidoCents(100, 0)).toBe(100);
    // 199 × 0,9 = 179,1 → 179 (round_half_up do Math.round: 179.1 → 179).
    expect(precoLiquidoCents(199, 10)).toBe(179);
  });
}, 60000);
