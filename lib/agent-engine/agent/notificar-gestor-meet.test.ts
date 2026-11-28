import { describe, expect, it } from "vitest";
import { montarMensagemGestorMeet } from "./notificar-gestor-meet";

describe("montarMensagemGestorMeet", () => {
  it("inclui primeiro nome, reunião, link do Meet e resumo da demanda", () => {
    const msg = montarMensagemGestorMeet({
      primeiroNomeCliente: "Rogério",
      titulo: "Diagnóstico Operacional",
      quando: "sex., 20/11, 14:00",
      url: "https://meet.google.com/gco-xxmb-imt",
      resumoDemanda: "Quero automatizar o atendimento do WhatsApp e agendar reuniões.",
    });

    expect(msg).toContain("Link do Google Meet pronto");
    expect(msg).toContain("Rogério");
    expect(msg).toContain("Diagnóstico Operacional (sex., 20/11, 14:00)");
    expect(msg).toContain("https://meet.google.com/gco-xxmb-imt");
    expect(msg).toContain("Quero automatizar o atendimento do WhatsApp e agendar reuniões.");
  });

  it("omite linha de resumo quando não houver mensagens anteriores", () => {
    const msg = montarMensagemGestorMeet({
      primeiroNomeCliente: null,
      titulo: null,
      quando: "sex., 20/11, 14:00",
      url: "https://meet.google.com/abc-defg-hij",
      resumoDemanda: null,
    });

    expect(msg).toContain("Não informado");
    expect(msg).toContain("Atendimento");
    expect(msg).not.toContain("Resumo da demanda:");
  });
});
