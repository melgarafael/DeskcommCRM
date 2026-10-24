import { describe, expect, it } from "vitest";
import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";

describe("a mensagem inteira preserva o alvo humano depois do consentimento", () => {
  it.each([
    "Posso passar para o setor financeiro? Eles resolvem até amanhã.",
    "Posso encaminhar para a equipe? O retorno sai em 2 horas.",
    "Quer que eu passe para o gerente? Ele retorna amanhã cedo.",
    "Quer que eu encaminhe para o time? Em até 1 hora alguém fala com você.",
    "Posso transferir para a equipe? Hoje mesmo eles entram em contato.",
  ])("continua sendo promessa: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });

  it.each([
    "Posso encaminhar para a equipe?",
    "Posso encaminhar para a equipe? Nossa equipe atende diversos serviços.",
    "Quer que eu passe para o gerente? O horário de atendimento é das 8h às 18h.",
    "Posso encaminhar para a equipe? Eles não retornam amanhã.",
    "Posso encaminhar para a equipe? O retorno não sai em 2 horas.",
    "Posso consultar no sistema? O retorno sai em 2 horas.",
  ])("não inventa uma promessa humana: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(false);
  });

  it("preserva também a retaguarda nomeada pela organização", () => {
    expect(
      detectHumanPromise("Quer que eu passe para a Luana? Eles respondem amanhã.", ["Luana"]),
    ).toBe(true);
    expect(detectHumanPromise("Quer que eu passe para a Luana?", ["Luana"])).toBe(false);
  });
});
