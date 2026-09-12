import { describe, expect, it } from "vitest";
import { detectHandoffConfirmation } from "@/lib/agent-engine/agent/human-handoff";

describe("detectHandoffConfirmation", () => {
  it("retorna true quando bot ofereceu handoff e lead respondeu sim", () => {
    expect(
      detectHandoffConfirmation({
        message: "sim",
        lastBotMessage: "Posso encaminhar para a equipe humana?",
      }),
    ).toBe(true);
  });

  it("retorna true para resposta pode com oferta de transferência", () => {
    expect(
      detectHandoffConfirmation({
        message: "pode",
        lastBotMessage: "Quer que eu transfira para um atendente humano?",
      }),
    ).toBe(true);
  });

  it("retorna true para claro com menção a encaminhar", () => {
    expect(
      detectHandoffConfirmation({
        message: "claro!",
        lastBotMessage: "Gostaria de encaminhar você para falar com alguém da equipe?",
      }),
    ).toBe(true);
  });

  it("retorna false quando lead responde sim mas bot não ofereceu handoff", () => {
    expect(
      detectHandoffConfirmation({
        message: "sim",
        lastBotMessage: "A aula é às 18h, confirma?",
      }),
    ).toBe(false);
  });

  it("retorna false quando bot ofereceu handoff mas lead respondeu negativamente", () => {
    expect(
      detectHandoffConfirmation({
        message: "não precisa",
        lastBotMessage: "Posso encaminhar para a equipe humana?",
      }),
    ).toBe(false);
  });

  it("retorna false quando message ou lastBotMessage estão vazios", () => {
    expect(detectHandoffConfirmation({ message: "", lastBotMessage: "encaminhar?" })).toBe(false);
    expect(detectHandoffConfirmation({ message: "sim", lastBotMessage: null })).toBe(false);
    expect(detectHandoffConfirmation({ message: "sim" })).toBe(false);
  });

  it("retorna true para resposta composta pode encaminhar", () => {
    expect(
      detectHandoffConfirmation({
        message: "pode encaminhar",
        lastBotMessage: "Deseja que eu encaminhe para a equipe humana?",
      }),
    ).toBe(true);
  });
});