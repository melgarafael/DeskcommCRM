import { describe, expect, it } from "vitest";

import { deriveTemplateContract } from "./template-contract";
import { mesclarValoresSalvos } from "./valores-salvos";

// Cabeçalho de imagem + `{{1}}` no corpo: as duas `key` são "1" e só o
// endereço separa — é o caso que prova que a chave é a do slot.
const contrato = deriveTemplateContract({
  name: "aviso_debriefing_adv",
  language: "pt_BR",
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Olá {{1}}, seu acesso está liberado." },
  ],
});

describe("mesclarValoresSalvos", () => {
  it("salva o link da mídia na chave do endereço", () => {
    expect(
      mesclarValoresSalvos(contrato, {}, { "header:1": " https://exemplo.com/capa.jpg " }),
    ).toEqual({ ok: true, valores: { "header:1": "https://exemplo.com/capa.jpg" } });
  });

  it("recusa guardar o valor do corpo, que costuma ser o nome do cliente", () => {
    expect(mesclarValoresSalvos(contrato, {}, { "1": "Maria" })).toEqual({
      ok: false,
      motivo: "chave_nao_e_midia",
      chave: "1",
    });
  });

  it("recusa link que a plataforma não consegue baixar", () => {
    for (const ruim of ["http://exemplo.com/a.jpg", "capa.jpg", "https://"]) {
      expect(mesclarValoresSalvos(contrato, {}, { "header:1": ruim })).toMatchObject({
        ok: false,
        motivo: "link_invalido",
      });
    }
  });

  it("valor vazio esquece o link salvo", () => {
    expect(
      mesclarValoresSalvos(contrato, { "header:1": "https://exemplo.com/velha.jpg" }, { "header:1": "" }),
    ).toEqual({ ok: true, valores: {} });
  });

  it("descarta o salvo de um slot que deixou de ser mídia", () => {
    const soTexto = deriveTemplateContract({
      name: "aviso_debriefing_adv",
      language: "pt_BR",
      components: [{ type: "HEADER", format: "TEXT", text: "Aviso" }],
    });
    expect(
      mesclarValoresSalvos(soTexto, { "header:1": "https://exemplo.com/capa.jpg" }, {}),
    ).toEqual({ ok: true, valores: {} });
  });
});
