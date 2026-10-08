import { describe, expect, it } from "vitest";

import { PROVEDORES_DE_COBRANCA as DO_VOCABULARIO } from "@/lib/cobranca/vocabulario";

import { ErroDoProvedor, paraErroDeLeitura, PROVEDORES_DE_COBRANCA } from "./contrato";

describe("contrato de provedor de cobrança", () => {
  it("a lista de provedores é a do vocabulário (reexportada, não redeclarada)", () => {
    expect(PROVEDORES_DE_COBRANCA).toBe(DO_VOCABULARIO);
  });

  it("⭐ a mensagem do erro só tem status e código — nunca URL, cabeçalho ou corpo", () => {
    const e = new ErroDoProvedor(402, "card_declined", false);
    expect(e.message).toBe("provedor 402 card_declined");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ErroDoProvedor");
    expect(new ErroDoProvedor(null, "sem_resposta", true).message).toBe("provedor sem_resposta sem_resposta");
  });

  it.each([
    ["chave que não serve mais", new ErroDoProvedor(401, "api_key_expired", false, true), "credencial_invalida"],
    ["provedor fora do ar", new ErroDoProvedor(503, "api_error", true), "provedor_fora"],
    ["sem resposta", new ErroDoProvedor(null, "sem_resposta", true), "provedor_fora"],
    ["resposta fora do formato", new ErroDoProvedor(200, "resposta_invalida", false), "leitura_invalida"],
    ["⭐ cliente que não existe nesta conta (chave de outra conta)", new ErroDoProvedor(404, "resource_missing", false), "leitura_invalida"],
    ["erro que não veio do adaptador (defeito nosso)", new Error("x"), "leitura_invalida"],
  ] as const)("%s → %s", (_, erro, esperado) => {
    expect(paraErroDeLeitura(erro)).toBe(esperado);
  });
});
