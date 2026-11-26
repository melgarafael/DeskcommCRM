import { describe, expect, it } from "vitest";
import { idDaOcorrencia } from "@/lib/agendamento-mensagem/envio";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AG = "b95651d4-12d7-4e1d-9186-1bda6a7bcf75";

describe("id da mensagem de cada ocorrência de série", () => {
  it("é um UUID v4 válido (a coluna messages.id é uuid)", () => {
    expect(idDaOcorrencia(AG, "2026-11-24T12:00:00.000Z")).toMatch(UUID_V4);
  });

  it("é determinístico: a rodada que cai no meio reencontra a mesma linha", () => {
    expect(idDaOcorrencia(AG, "2026-11-24T12:00:00.000Z")).toBe(idDaOcorrencia(AG, "2026-11-24T12:00:00.000Z"));
  });

  it("muda de uma ocorrência para a outra do mesmo agendamento", () => {
    // Esta é a regressão: com o id do agendamento, a 2ª ocorrência devolvia a 1ª sem enviar.
    expect(idDaOcorrencia(AG, "2026-11-24T12:00:00.000Z")).not.toBe(idDaOcorrencia(AG, "2026-12-08T12:00:00.000Z"));
  });

  it("não coincide com o id do próprio agendamento", () => {
    expect(idDaOcorrencia(AG, "2026-11-24T12:00:00.000Z")).not.toBe(AG);
  });
});
