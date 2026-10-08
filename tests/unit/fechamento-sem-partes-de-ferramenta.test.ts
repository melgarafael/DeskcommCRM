import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { toolPartsAsText } from "@/lib/agent-engine/agent/prune-tool-results";

// O fechamento (checkpoint) vai SEM `tools`. A fita inteira do turno traz
// tool-call/tool-result, e a Anthropic recusa esses blocos sem tools definidas:
// o fechamento lançaria depois de a resposta já ter saído.
const fita: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "Vou reservar." },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "crm_book_appointment",
        input: { starts_at: "2030-07-03T20:00:00Z" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "crm_book_appointment",
        output: { type: "json", value: { id: "a1", quando: "quarta, 03/07 às 17:00", nota: "x".repeat(5000) } },
      },
    ],
  },
  { role: "assistant", content: "Pronto, ficou para quarta às 17h." },
];

describe("o fechamento recebe as ferramentas do turno como texto", () => {
  const achatada = toolPartsAsText(fita, 200);
  const serializada = JSON.stringify(achatada);

  it("nenhuma parte tool-call/tool-result e nenhuma mensagem tool", () => {
    expect(achatada.filter((m) => m.role === "tool")).toEqual([]);
    expect(serializada).not.toMatch(/"type":"tool-(call|result)"/);
  });

  it("a reserva feita segue visível, com o texto do assistant intacto", () => {
    expect(serializada).toContain("Vou reservar.");
    expect(serializada).toContain("[ferramenta crm_book_appointment chamada com");
    expect(serializada).toContain("quarta, 03/07 às 17:00");
    expect(achatada.at(-1)).toEqual({ role: "assistant", content: "Pronto, ficou para quarta às 17h." });
  });

  it("cada resultado tem teto (o knob MIN_RESULT_TOKENS do pruning)", () => {
    // 200 tokens × 3,5 chars: o resultado de 5 mil caracteres não entra inteiro.
    expect(serializada.length).toBeLessThan(1200);
  });
});
