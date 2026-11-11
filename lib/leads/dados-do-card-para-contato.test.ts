import { describe, expect, it } from "vitest";
import { dadosDoCardParaContato } from "./dados-do-card-para-contato";

describe("dados do card para contato", () => {
  it("não transforma endereço e identificador antigo em telefone", () => {
    expect(
      dadosDoCardParaContato({
        custom_fields: {},
        tags: [],
        description: "Origem: 10357\nEndereço: Rua 12, 123",
      }).phone_number,
    ).toBeUndefined();
  });
  it("preserva telefone sem DDD para conferência, sem inventar prefixo", () => {
    expect(
      dadosDoCardParaContato({
        custom_fields: {},
        tags: ["rede"],
        description: "Telefone original 1: 2655-9389\nEmail: exemplo@example.com",
      }),
    ).toEqual({ phone_number: "2655-9389", email: "exemplo@example.com", tags: ["rede"] });
  });
  it("vários telefones exigem escolha, o campo estruturado tem precedência", () => {
    const lead = {
      custom_fields: {},
      tags: [],
      description: "Telefone original 1: 2655-9389\nTelefone original 2: 2222-3333",
    };
    expect(dadosDoCardParaContato(lead).phone_number).toBeUndefined();
    expect(
      dadosDoCardParaContato({ ...lead, custom_fields: { phone_number: "+5521999998888" } })
        .phone_number,
    ).toBe("+5521999998888");
  });
});
