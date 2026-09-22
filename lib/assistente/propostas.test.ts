import { describe, expect, it } from "vitest";

import { ACOES_DO_ASSISTENTE, ehAcaoConhecida } from "./propostas";

describe("assistente — registro de ações", () => {
  it("conhece as 6 ações, todas com piso agent (espelho das rotas)", () => {
    expect(Object.keys(ACOES_DO_ASSISTENTE).sort()).toEqual(
      ["agendar", "criar_contato", "criar_lead", "criar_pedido", "criar_tarefa", "emitir_nota"].sort(),
    );
    for (const def of Object.values(ACOES_DO_ASSISTENTE)) {
      expect(def.piso).toBe("agent");
    }
    expect(ehAcaoConhecida("criar_pedido")).toBe(true);
    expect(ehAcaoConhecida("apagar_banco")).toBe(false);
  });

  it("proposta de pedido exige cliente + ao menos 1 item com código", () => {
    const schema = ACOES_DO_ASSISTENTE.criar_pedido.schema;
    const base = {
      cliente_nome: "Claudio Andrade",
      itens: [{ codigo: "EST-10", quantidade: 2, preco_unit_cents: 1000 }],
    };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, itens: [] }).success).toBe(false);
    expect(schema.safeParse({ ...base, cliente_nome: "X" }).success).toBe(false);
    // Sem código não resolve: o executor precisa dele para precificar.
    expect(
      schema.safeParse({ cliente_nome: "Claudio", itens: [{ quantidade: 1, preco_unit_cents: 10 }] }).success,
    ).toBe(false);
  });

  it("proposta de nota exige order_id uuid", () => {
    const schema = ACOES_DO_ASSISTENTE.emitir_nota.schema;
    expect(schema.safeParse({ order_id: "nao-uuid" }).success).toBe(false);
    expect(schema.safeParse({ order_id: "123e4567-e89b-12d3-a456-426614174000" }).success).toBe(true);
  });

  it("proposta de agendamento exige data e hora válidas", () => {
    const schema = ACOES_DO_ASSISTENTE.agendar.schema;
    const base = {
      event_type_id: "123e4567-e89b-12d3-a456-426614174000",
      starts_at: "2026-09-20T10:00:00-03:00",
    };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, starts_at: "amanhã 10h" }).success).toBe(false);
  });

  it("proposta de tarefa exige título", () => {
    const schema = ACOES_DO_ASSISTENTE.criar_tarefa.schema;
    expect(schema.safeParse({ titulo: "X" }).success).toBe(false);
    expect(schema.safeParse({ titulo: "Visitar Claudio" }).success).toBe(true);
  });
});
