import { describe, expect, it } from "vitest";

import { enderecoEmLinha } from "./endereco-em-linha";

describe("enderecoEmLinha", () => {
  it("monta o endereço completo", () => {
    expect(
      enderecoEmLinha({
        logradouro: "Rua Antônio Liller",
        numero_end: "585",
        bairro: "Alto das Palmeiras",
        cidade: "Canoinhas",
        uf: "sc",
        cep: "89460-000",
      }),
    ).toBe("Rua Antônio Liller, 585 — Alto das Palmeiras, Canoinhas/SC, 89460-000");
  });

  it("rua sem número não deixa vírgula solta", () => {
    expect(enderecoEmLinha({ logradouro: "RUA JACOB RANK S/N", cidade: "Mafra", uf: "SC" })).toBe(
      "RUA JACOB RANK S/N — Mafra/SC",
    );
  });

  it("só cidade sai sozinha, sem traço nem vírgula", () => {
    expect(enderecoEmLinha({ cidade: "Irati", uf: "PR" })).toBe("Irati/PR");
  });

  it("complemento entra na primeira parte", () => {
    expect(
      enderecoEmLinha({ logradouro: "Av. X", numero_end: "10", complemento: "Sala 2", cidade: "Canoinhas", uf: "SC" }),
    ).toBe("Av. X, 10 — Sala 2 — Canoinhas/SC");
  });

  it("não duplica o número que já veio colado no logradouro (dado do WP)", () => {
    expect(
      enderecoEmLinha({
        logradouro: "RUA OROCIMBO CAETANO DA SILVA, 65",
        numero_end: "65",
        bairro: "VILA NOSSA SENHORA APARECIDA",
        cidade: "Curitibanos",
        uf: "SC",
        cep: "89520000",
      }),
    ).toBe("RUA OROCIMBO CAETANO DA SILVA, 65 — VILA NOSSA SENHORA APARECIDA, Curitibanos/SC, 89520000");
  });

  it("nada vira string vazia (o literal de ausência é da tela)", () => {
    expect(enderecoEmLinha(null)).toBe("");
    expect(enderecoEmLinha({})).toBe("");
    expect(enderecoEmLinha({ logradouro: "  " })).toBe("");
  });
});
