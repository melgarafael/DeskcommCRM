import { describe, expect, it } from "vitest";

import {
  apareceNaFaixa,
  campoDeInstante,
  fusoDoNavegador,
  instanteDoCampo,
  previaDoPacote,
  sugestaoDeHorario,
  type PacoteAgendado,
} from "./agendamento-na-conversa";

/**
 * A conversão que só o NAVEGADOR sabe fazer (#3118): hora de parede do campo
 * `<input type="datetime-local">` ↔ instante absoluto que a API grava.
 *
 * O erro que este teste existe para impedir é silencioso e caro: um agendamento
 * que sai três horas fora do horário combinado. Não quebra nada, não aparece no
 * log, e quem descobre é o cliente recebendo mensagem de madrugada.
 */
describe("instanteDoCampo", () => {
  it("lê o texto do campo como hora LOCAL e devolve o instante ISO", () => {
    // O fuso do processo de teste pode ser qualquer um; o contrato é a IGUALDADE
    // entre o que `new Date(texto)` entendeu e o ISO devolvido.
    const esperado = new Date("2026-11-02T09:30").toISOString();
    expect(instanteDoCampo("2026-11-02T09:30")).toBe(esperado);
  });

  it("campo vazio ou ilegível vira null, nunca 'Invalid Date'", () => {
    expect(instanteDoCampo("")).toBeNull();
    expect(instanteDoCampo("   ")).toBeNull();
    expect(instanteDoCampo("amanhã de manhã")).toBeNull();
  });

  it("ida e volta preserva o horário de parede", () => {
    const quando = new Date("2026-11-02T09:30");
    expect(instanteDoCampo(campoDeInstante(quando))).toBe(quando.toISOString());
  });
});

describe("campoDeInstante", () => {
  it("usa dois dígitos e o formato que o input aceita", () => {
    expect(campoDeInstante(new Date(2026, 0, 5, 7, 4))).toBe("2026-01-05T07:04");
  });

  it("não converte para UTC — o campo é hora de parede", () => {
    const local = new Date(2026, 5, 15, 23, 59);
    expect(campoDeInstante(local)).toBe("2026-06-15T23:59");
  });
});

describe("sugestaoDeHorario", () => {
  it("abre uma hora à frente, no próximo quarto de hora", () => {
    expect(sugestaoDeHorario(new Date(2026, 10, 2, 9, 7))).toBe("2026-11-02T10:15");
  });

  it("quarto de hora exato não é empurrado para o seguinte", () => {
    expect(sugestaoDeHorario(new Date(2026, 10, 2, 9, 15))).toBe("2026-11-02T10:15");
  });

  it("vira o dia quando a hora passa da meia-noite", () => {
    expect(sugestaoDeHorario(new Date(2026, 10, 2, 23, 40))).toBe("2026-11-03T00:45");
  });
});

describe("apareceNaFaixa", () => {
  it("mostra o que ainda vai sair e o que precisa de gente", () => {
    expect(apareceNaFaixa("scheduled")).toBe(true);
    expect(apareceNaFaixa("sending")).toBe(true);
    expect(apareceNaFaixa("partial")).toBe(true);
    expect(apareceNaFaixa("failed")).toBe(true);
  });

  it("esconde o que virou história", () => {
    expect(apareceNaFaixa("sent")).toBe(false);
    expect(apareceNaFaixa("cancelled")).toBe(false);
  });
});

describe("previaDoPacote", () => {
  function pacote(partes: PacoteAgendado["parts"]): PacoteAgendado {
    return {
      id: "p1",
      conversation_id: "c1",
      scheduled_for: "2026-11-02T12:30:00.000Z",
      tz: "America/Sao_Paulo",
      status: "scheduled",
      cancel_if_contact_replies: false,
      cancel_reason: null,
      cancelled_at: null,
      last_error: null,
      created_at: "2026-11-01T12:00:00.000Z",
      parts: partes,
    };
  }

  const parte = (position: number, body: string | null): PacoteAgendado["parts"][number] => ({
    id: `parte-${position}`,
    position,
    body,
    media_mime: body === null ? "image/jpeg" : null,
    media_size_bytes: null,
    status: "pending",
    error_code: null,
    sent_at: null,
  });

  it("pega o texto da PRIMEIRA parte com conteúdo, não da primeira da lista", () => {
    // A ordem é `position`: uma parte só de anexo vem antes do texto.
    expect(previaDoPacote(pacote([parte(0, null), parte(1, "  Bom dia  ")]))).toBe("Bom dia");
  });

  it("pacote só de anexo devolve null para a tela escolher a palavra", () => {
    expect(previaDoPacote(pacote([parte(0, null)]))).toBeNull();
  });
});

describe("fusoDoNavegador", () => {
  it("devolve um nome IANA que o Intl aceita", () => {
    const tz = fusoDoNavegador();
    expect(tz.length).toBeGreaterThan(0);
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz })).not.toThrow();
  });
});
