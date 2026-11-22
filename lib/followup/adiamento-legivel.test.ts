import { describe, expect, it } from "vitest";

import { descreverAdiamento, grupoDoAdiamento } from "./adiamento-legivel";

/**
 * O ADIAMENTO DIZ O MOTIVO DE VERDADE — E SÓ CULPA A JANELA ONDE ELA EXISTE.
 *
 * Medido na #4913: follow-up de uma conexão por QR, IA escreveu, envio não
 * saiu, e o histórico registrou "a janela estava fechada". Naquele canal não
 * existe janela de 24 h; quem segurou foi outra coisa. O motivo sempre esteve
 * no `payload.reason` — o que faltava era ler.
 */

const QUANDO = "18 nov., 14:30";

const oficial = (reason: unknown) =>
  descreverAdiamento({ reason, quando: QUANDO, janelaRegulatoria: true });
const qr = (reason: unknown) =>
  descreverAdiamento({ reason, quando: QUANDO, janelaRegulatoria: false });

describe("grupoDoAdiamento — o motivo, na granularidade que o operador lê", () => {
  it("nomeia cada motivo que o motor grava", () => {
    expect(grupoDoAdiamento("outside_window", false)).toBe("horario_do_canal");
    expect(grupoDoAdiamento("followup_send_window", false)).toBe("faixa_do_acompanhamento");
    expect(grupoDoAdiamento("pessoa_no_comando", false)).toBe("pessoa_no_comando");
    expect(grupoDoAdiamento("mass_identical", false)).toBe("repeticao");
    expect(grupoDoAdiamento("pacing_throttle", false)).toBe("ritmo");
    expect(grupoDoAdiamento("daily_cap", false)).toBe("ritmo");
  });

  it("motivo de janela só é regulatório onde o canal tem essa janela", () => {
    expect(grupoDoAdiamento("messaging_window_closed", true)).toBe("janela_regulatoria");
    expect(grupoDoAdiamento("messaging_window_closed", false)).toBe("horario_do_canal");
  });

  it("motivo ausente ou desconhecido não inventa causa", () => {
    expect(grupoDoAdiamento(undefined, false)).toBe("generico");
    expect(grupoDoAdiamento("motivo_que_ainda_nao_existe", false)).toBe("generico");
  });
});

describe("canal OFICIAL — a mensagem da janela de 24 h é a de antes, byte por byte", () => {
  it("janela regulatória mantém título e detalhe originais", () => {
    expect(oficial("messaging_window_closed")).toEqual({
      titulo: "Segurou o envio até o horário permitido",
      detalhe: `a janela estava fechada; envia em ${QUANDO}`,
    });
  });

  it("o horário de envio da conexão não é confundido com a janela de 24 h", () => {
    expect(oficial("outside_window")).toEqual({
      titulo: "Segurou o envio até o horário permitido",
      detalhe: `o horário de envio desta conexão estava fechado; envia em ${QUANDO}`,
    });
  });
});

describe("conexão por QR — nunca anuncia a janela de 24 h", () => {
  const MOTIVOS = [
    "messaging_window_closed",
    "outside_window",
    "followup_send_window",
    "pessoa_no_comando",
    "mass_identical",
    "pacing_throttle",
    "motivo_que_ainda_nao_existe",
    null,
  ];

  it("nenhuma frase de adiamento de QR fala em janela nem em 24 horas", () => {
    for (const motivo of MOTIVOS) {
      const { titulo, detalhe } = qr(motivo);
      expect(`${titulo} ${detalhe ?? ""}`.toLowerCase()).not.toContain("janela");
      expect(`${titulo} ${detalhe ?? ""}`.toLowerCase()).not.toContain("24 horas");
    }
  });

  it("pessoa no comando é dita como pessoa no comando", () => {
    expect(qr("pessoa_no_comando")).toEqual({
      titulo: "Esperou uma pessoa devolver a conversa ao automático",
      detalhe: `confere de novo em ${QUANDO}`,
    });
  });

  it("repetição e ritmo são ditos como repetição e ritmo", () => {
    expect(qr("mass_identical").titulo).toBe("Segurou para não repetir a mesma mensagem");
    expect(qr("daily_cap").titulo).toBe("Segurou o envio pelo ritmo deste número");
  });

  it("o horário de envio da conexão é dito como horário de envio", () => {
    expect(qr("outside_window")).toEqual({
      titulo: "Segurou o envio até o horário permitido",
      detalhe: `o horário de envio desta conexão estava fechado; envia em ${QUANDO}`,
    });
  });
});

describe("sem data — a frase continua sem inventar horário", () => {
  it("regulatória sem `until` não promete instante", () => {
    expect(
      descreverAdiamento({ reason: "messaging_window_closed", quando: null, janelaRegulatoria: true }),
    ).toEqual({ titulo: "Segurou o envio até o horário permitido", detalhe: "a janela estava fechada" });
  });

  it("motivo sem data fica no essencial", () => {
    expect(
      descreverAdiamento({ reason: "pessoa_no_comando", quando: null, janelaRegulatoria: false }),
    ).toEqual({ titulo: "Esperou uma pessoa devolver a conversa ao automático", detalhe: null });
  });
});
