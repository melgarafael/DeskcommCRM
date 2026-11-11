import { describe, expect, it } from "vitest";

import { hrefDoCompromisso, puloDaAgendaDaMensagem } from "./pulo-da-agenda";

/**
 * O DISCRIMINADOR DO PULO DA AGENDA É O PAR QUE O BANCO JÁ GRAVA (#3848):
 * `status = failed` + `error_code = compromisso_na_agenda`.
 *
 * O retrato em `metadata` é enfeite com valor (diz QUAL compromisso barrou),
 * não o critério: uma linha anterior a esta entrega já é um pulo e não pode
 * cair no selo de falha por falta do retrato. E `metadata` é jsonb escrito por
 * terceiros — objeto torto não pode derrubar a bolha.
 */
const linha = (over: Record<string, unknown> = {}) =>
  ({
    status: "failed",
    error_code: "compromisso_na_agenda",
    metadata: {},
    ...over,
  }) as Parameters<typeof puloDaAgendaDaMensagem>[0];

describe("puloDaAgendaDaMensagem", () => {
  it("failed + o código do pulo é pulo, mesmo sem retrato nenhum", () => {
    expect(puloDaAgendaDaMensagem(linha())).toEqual({ appointment_id: null, motivo: null, titulo: null });
  });

  it("qualquer outro desfecho não é pulo: falha real, mensagem enviada, linha na fila", () => {
    expect(puloDaAgendaDaMensagem(linha({ error_code: "storage_sign_failed" }))).toBeNull();
    expect(puloDaAgendaDaMensagem(linha({ status: "sent" }))).toBeNull();
    expect(puloDaAgendaDaMensagem(linha({ status: "queued", error_code: null }))).toBeNull();
  });

  it("o retrato é lido quando existe, e motivo fora do vocabulário não vira frase", () => {
    const comRetrato = linha({
      metadata: { pulo_da_agenda: { appointment_id: "ap-1", motivo: "em_atendimento", titulo: "Avaliação" } },
    });
    expect(puloDaAgendaDaMensagem(comRetrato)).toEqual({
      appointment_id: "ap-1",
      motivo: "em_atendimento",
      titulo: "Avaliação",
    });
    const motivoDesconhecido = linha({
      metadata: { pulo_da_agenda: { appointment_id: "ap-1", motivo: "outra_coisa", titulo: " " } },
    });
    expect(puloDaAgendaDaMensagem(motivoDesconhecido)).toEqual({
      appointment_id: "ap-1",
      motivo: null,
      titulo: null,
    });
  });

  it("retrato torto (string, lista, nulo) não lança: só perde o compromisso", () => {
    for (const torto of ["texto", ["ap-1"], null, 42]) {
      expect(puloDaAgendaDaMensagem(linha({ metadata: { pulo_da_agenda: torto } }))).toEqual({
        appointment_id: null,
        motivo: null,
        titulo: null,
      });
    }
  });

  it("o destino é a rota que a agenda já usa; sem id não há link inventado", () => {
    expect(hrefDoCompromisso({ appointment_id: "ap-1", motivo: null, titulo: null })).toBe(
      "/app/agenda?compromisso=ap-1",
    );
    expect(hrefDoCompromisso({ appointment_id: null, motivo: null, titulo: null })).toBeNull();
  });
});
