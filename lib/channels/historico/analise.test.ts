import { describe, expect, it } from "vitest";

import {
  montarTranscricaoDoHistorico,
  parseResultadoDaAnaliseDoHistorico,
  qualificationPreenchida,
} from "./analise";

const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";

describe("análise do histórico", () => {
  it("monta a fita em ordem e conserva o trecho mais novo quando trunca", () => {
    const fita = montarTranscricaoDoHistorico(
      [
        { id: ID_1, direction: "inbound", sent_at: "2026-01-01", body: "quero 500 cadeiras" },
        { id: ID_2, direction: "outbound", sent_at: "2026-01-02", body: "vou enviar a proposta" },
      ],
      100,
    );
    expect(fita.truncada).toBe(true);
    expect(fita.texto).toContain(ID_2);
    expect(fita.texto).not.toContain(ID_1);
  });

  it("recusa evidência que o modelo inventou", () => {
    const resposta = JSON.stringify({
      commitments: [],
      objections: [],
      next_action: null,
      rolling_summary: "Cliente pediu cotação.",
      qualification: { budget: null, authority: null, need: "cadeiras", timeline: null },
      evidence_message_ids: [ID_2],
    });
    expect(() => parseResultadoDaAnaliseDoHistorico(resposta, new Set([ID_1]))).toThrow(
      "analise_historico_evidencia_inventada",
    );
  });

  it("remove nulos antes de atualizar o BANT existente", () => {
    expect(
      qualificationPreenchida({ budget: null, authority: "decisor", need: "500 cadeiras", timeline: null }),
    ).toEqual({ authority: "decisor", need: "500 cadeiras" });
  });
});
