import { describe, expect, it } from "vitest";

import { ErroDeCep, buscarCep, mapearViaCep, normalizarCep } from "./cep";

describe("cep", () => {
  it("normaliza com máscara e recusa curto", () => {
    expect(normalizarCep("89460-000")).toBe("89460000");
    expect(normalizarCep("89460000")).toBe("89460000");
    expect(normalizarCep("8946")).toBeNull();
    expect(normalizarCep(null)).toBeNull();
  });

  it("mapeia a resposta do ViaCEP para os campos", () => {
    expect(
      mapearViaCep({
        logradouro: "Rua Caetano Costa",
        complemento: "",
        bairro: "Centro",
        localidade: "Canoinhas",
        uf: "sc",
      }),
    ).toEqual({
      logradouro: "Rua Caetano Costa",
      complemento: "",
      bairro: "Centro",
      cidade: "Canoinhas",
      uf: "SC",
    });
  });

  it("CEP curto nem chama a rede", async () => {
    await expect(buscarCep("123")).rejects.toMatchObject({ codigo: "cep_invalido" });
  });

  it("erro nomeado tem código legível", () => {
    expect(new ErroDeCep("nao_encontrado").codigo).toBe("nao_encontrado");
  });
});
