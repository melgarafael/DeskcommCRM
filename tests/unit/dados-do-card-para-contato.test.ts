import { expect, it } from "vitest";
import { dadosDoCardParaContato } from "@/lib/leads/dados-do-card-para-contato";
it("aproveita somente identificadores rotulados, sem inferir endereço ou documento", () => {
  const result = dadosDoCardParaContato({
    custom_fields: {},
    description:
      "CPF: 12345678900\nRua: 123\nEmail: pessoa@example.invalid\nWhatsApp: +5511999999999",
    tags: ["origem"],
  });
  expect(result).toEqual({
    email: "pessoa@example.invalid",
    phone_number: "+5511999999999",
    tags: ["origem"],
  });
});
it("não escolhe entre telefones ambíguos e respeita campo explícito", () => {
  const card = {
    custom_fields: {},
    description: "Telefone: +5511999999999\nTelefone 2: +5511888888888",
    tags: [],
  };
  expect(dadosDoCardParaContato(card).phone_number).toBeUndefined();
  expect(
    dadosDoCardParaContato({ ...card, custom_fields: { phone_number: "+5511777777777" } })
      .phone_number,
  ).toBe("+5511777777777");
});
