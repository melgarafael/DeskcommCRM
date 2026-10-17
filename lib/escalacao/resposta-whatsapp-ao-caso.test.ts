import { describe, expect, it } from "vitest";

import { parseComandoDeRespostaDoSuporte } from "./resposta-whatsapp-ao-caso";

const CASO = "02920000-5555-4000-8000-000000000001";

describe("parseComandoDeRespostaDoSuporte", () => {
  it("lê uma decisão endereçada ao caso exato", () => {
    expect(parseComandoDeRespostaDoSuporte(`RESPONDER ${CASO} A escola confirmou o tamanho G.`)).toEqual({
      caseId: CASO,
      action: "resolved",
      body: "A escola confirmou o tamanho G.",
    });
  });

  it("lê um pedido para a IA perguntar algo ao cliente", () => {
    expect(parseComandoDeRespostaDoSuporte(`perguntar ${CASO} Pergunte qual escola ele frequenta.`)).toEqual({
      caseId: CASO,
      action: "need_lead_info",
      body: "Pergunte qual escola ele frequenta.",
    });
  });

  it.each([
    "A escola tem tamanho G.",
    `RESPONDER ${CASO} `,
    `RESPONDER ${CASO} ${"a".repeat(4001)}`,
    "RESPONDER nao-e-uuid diga sim",
  ])("recusa comando ausente ou malformado: %s", (texto) => {
    expect(parseComandoDeRespostaDoSuporte(texto)).toBeNull();
  });
});
