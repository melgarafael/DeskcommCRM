import { describe, expect, it } from "vitest";
import { missionPrompt } from "./schema";
import { callSuggestions, serializeCallContext, voiceGreeting } from "./context";

describe("contexto da ligação", () => {
  it("preserva mensagens recentes e JSON válido quando o histórico ultrapassa o limite", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      direction: i % 2 ? "outbound" : "inbound",
      body: `${i}: ${'"'.repeat(1600)}`,
      sent_at: new Date(2026, 8, 22, 0, 40 - i).toISOString(),
    }));
    const serialized = serializeCallContext("Empresa", "Ana", messages);
    const result = JSON.parse(serialized);
    expect(serialized.length).toBeLessThan(24000);
    expect(result.cliente).toBe("Ana");
    expect(result.mensagens.at(-1).texto).toContain("0:");
    expect(result.mensagens.length).toBeLessThan(40);
    expect(messages[0]!.body).toContain("0:");
  });

  it("usa a mensagem do cliente como evidência, sem atribuir a ele a fala da empresa", () => {
    const result = callSuggestions([
      { id: "empresa", direction: "outbound", body: "A proposta custa 500", sent_at: "2026-09-22" },
      {
        id: "cliente",
        direction: "inbound",
        body: "Posso dividir o pagamento?",
        sent_at: "2026-09-21",
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.message_id).toBe("cliente");
    expect(result[0]!.evidence).toBe("Posso dividir o pagamento?");
    expect(result[0]!.objective).toContain("Posso dividir o pagamento?");
  });

  it("não inventa sugestões quando falta uma mensagem do cliente", () => {
    expect(callSuggestions([])).toEqual([]);
    expect(
      callSuggestions([{ direction: "outbound", body: "Olá", sent_at: "2026-09-22" }]),
    ).toEqual([]);
  });
});

it("usa orientação própria de voz sem depender de instruções de um agente", () => {
  const prompt = missionPrompt("Esclarecer a entrega", '{"cliente":"Ana"}');
  expect(prompt).toContain("Sua especialidade é conversar por telefone");
  expect(prompt).toContain("Esclarecer a entrega");
  expect(prompt).toContain('"cliente":"Ana"');
  expect(prompt).toContain("não diga que alterou cadastro");
});

it("usa o horário da empresa e não inventa saudação com fuso inválido", () => {
  expect(voiceGreeting("America/Sao_Paulo", new Date("2026-09-22T12:00:00Z"))).toBe("Bom dia");
  expect(voiceGreeting("America/Sao_Paulo", new Date("2026-09-22T18:00:00Z"))).toBe("Boa tarde");
  expect(voiceGreeting("America/Sao_Paulo", new Date("2026-09-23T01:00:00Z"))).toBe("Boa noite");
  expect(voiceGreeting("invalid")).toBe("");
  expect(
    JSON.parse(
      serializeCallContext("Loja", "João", [], { requester: "Felipe", greeting: "Boa noite" }),
    ),
  ).toMatchObject({ solicitante: "Felipe", saudacao: "Boa noite" });
});
