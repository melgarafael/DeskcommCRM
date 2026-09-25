import { describe, expect, it } from "vitest";

import { buildOpeningMessage } from "@/lib/agent-engine/agent/inbound-turn";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

/**
 * O BLOCO FIXO DE COLETA CEDE LUGAR AO FLUXO.
 *
 * Decisão do dono: quando há um fluxo de atendimento ATIVO, as perguntas são do
 * fluxo — o bloco "Dados essenciais / PENDENTES" (C-012) não pode coexistir, ou
 * o agente recebe dois roteiros de coleta no mesmo turno. Sem fluxo, o bloco
 * continua exatamente como era (o par deste arquivo é o controle).
 */
function contexto(custom_fields: Record<string, unknown>): LeadContext {
  return {
    lead_id: "11111111-1111-4111-8111-111111111111",
    contact: {
      name: null,
      phone: null,
      email: null,
      tags: [],
      is_blocked: false,
      custom_fields,
    },
    conversation_id: null,
    last_human_decision: null,
    messages: [],
  };
}

function abertura(
  custom_fields: Record<string, unknown>,
  fluxoAtivo: boolean,
  interesseEmMoto = false,
): string {
  return buildOpeningMessage(
    null,
    null,
    contexto(custom_fields),
    "—",
    false,
    [],
    "",
    undefined,
    fluxoAtivo,
    interesseEmMoto,
  );
}

describe("quando há fluxo, o bloco fixo de coleta cede", () => {
  it("SEM fluxo: o bloco 'Dados essenciais' e os PENDENTES aparecem (controle)", () => {
    const texto = abertura({}, false);
    expect(texto).toContain("## Dados essenciais do cliente");
    expect(texto).toContain("PENDENTES:");
  });

  it("COM fluxo: o bloco some por inteiro — a coleta é do fluxo", () => {
    const texto = abertura({}, true);
    expect(texto).not.toContain("## Dados essenciais do cliente");
    expect(texto).not.toContain("PENDENTES:");
  });

  it("COM fluxo, o resto do ritual continua (não é uma abertura vazia)", () => {
    // A prova de que o bloco SAIU sem levar o prompt junto: os marcadores do
    // ritual permanecem.
    const texto = abertura({}, true);
    expect(texto).toContain("Novo turno de atendimento");
    expect(texto).toContain("## Estado do funil");
  });
});

describe("C-084 — coleta ativa de nome/cidade/CNH", () => {
  it("SEM interesse em moto: a coleta fica represada (não pergunta CNH ainda)", () => {
    const texto = abertura({}, false, false);
    expect(texto).toContain("PENDENTES:");
    expect(texto).toMatch(/Ainda NÃO pergunte CNH\/CPF/);
  });

  it("COM interesse em moto: a coleta é liberada e vira o fecho do turno", () => {
    const texto = abertura({}, false, true);
    expect(texto).toContain("PENDENTES:");
    expect(texto).toMatch(/JÁ demonstrou interesse em moto/);
    expect(texto).toMatch(/TERMINE o turno pedindo UM destes dados/);
    // A ordem e a persistência (2 tentativas) estão na instrução.
    expect(texto).toMatch(/nome → cidade → CNH/);
    expect(texto).toMatch(/até 2 tentativas/);
  });

  it("dado já preenchido some dos PENDENTES", () => {
    const texto = abertura({ nome: "Vander", cidade: "São Paulo" }, false, true);
    // Só a CNH continua pendente (nome e cidade já no contato).
    expect(texto).toMatch(/PENDENTES: CNH\./);
    expect(texto).not.toMatch(/PENDENTES: nome/);
    expect(texto).not.toMatch(/PENDENTES:.*cidade\./);
  });
});
