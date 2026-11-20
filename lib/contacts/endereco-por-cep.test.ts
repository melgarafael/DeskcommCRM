/**
 * A régua do preenchimento por CEP (#3494, fatia 2) — pura, sem rede.
 *
 * Cada caso aqui responde a uma pergunta de produto que a tela não tem como
 * inventar: o que conta como CEP consultável, o que a resposta da BrasilAPI
 * vira em coluna e — o mais importante — o que o CEP NÃO pode sobrescrever.
 */
import { describe, expect, it } from "vitest";

import {
  CAMPOS_DO_ENDERECO,
  ENDERECO_VAZIO,
  comEnderecoDoCep,
  enderecoDoCep,
  formatarCep,
  normalizarCep,
  temEndereco,
} from "@/lib/contacts/endereco-por-cep";

describe("normalizarCep", () => {
  it("aceita as três grafias que o brasileiro digita", () => {
    expect(normalizarCep("01310100")).toBe("01310100");
    expect(normalizarCep("01310-100")).toBe("01310100");
    expect(normalizarCep(" 01310 100 ")).toBe("01310100");
  });

  it("recusa 7 dígitos, letras e vazio — sem lançar", () => {
    // O caso da issue: "CEP inválido não derruba a gravação". Aqui ele só
    // deixa de ser consultável; quem grava é o schema, e o campo é texto livre.
    expect(normalizarCep("0131010")).toBeNull();
    expect(normalizarCep("013101000")).toBeNull();
    expect(normalizarCep("ABCDEFGH")).toBeNull();
    expect(normalizarCep("")).toBeNull();
    expect(normalizarCep(null)).toBeNull();
    expect(normalizarCep(undefined)).toBeNull();
  });
});

describe("formatarCep", () => {
  it("põe o hífen só quando há 8 dígitos", () => {
    expect(formatarCep("01310100")).toBe("01310-100");
    expect(formatarCep("01310-100")).toBe("01310-100");
  });

  it("devolve o texto como veio quando não são 8 dígitos", () => {
    expect(formatarCep("0131010")).toBe("0131010");
    expect(formatarCep("")).toBe("");
  });
});

describe("enderecoDoCep", () => {
  it("traduz a resposta da BrasilAPI para as colunas do contato", () => {
    expect(
      enderecoDoCep({
        cep: "80000000",
        street: "Rua XV de Novembro",
        district: "Centro",
        city: "Curitiba",
        state: "pr",
      }),
    ).toEqual({
      zip_code: "80000-000",
      street: "Rua XV de Novembro",
      district: "Centro",
      city: "Curitiba",
      state: "PR",
    });
  });

  it("não devolve campo que veio vazio — vazio não apaga o que existe", () => {
    const campos = enderecoDoCep({ cep: "80000000", city: "Curitiba", state: "PR" });
    expect(campos).toEqual({ zip_code: "80000-000", city: "Curitiba", state: "PR" });
    expect(campos).not.toHaveProperty("district");
    expect(campos).not.toHaveProperty("street");
  });

  it("tolera resposta nula em qualquer campo", () => {
    expect(enderecoDoCep({ cep: null, street: null, district: null, city: "Araucária" })).toEqual({
      city: "Araucária",
    });
  });
});

describe("comEnderecoDoCep", () => {
  const digitado = {
    ...ENDERECO_VAZIO,
    number: "120",
    complement: "apto 42",
    district: "Bairro Digitado",
  };

  it("preenche o que o CEP sabe e NÃO toca em número nem complemento", () => {
    const resultado = comEnderecoDoCep(digitado, {
      cep: "80000000",
      street: "Rua XV de Novembro",
      district: "Centro",
      city: "Curitiba",
      state: "PR",
    });

    expect(resultado.number).toBe("120");
    expect(resultado.complement).toBe("apto 42");
    expect(resultado.street).toBe("Rua XV de Novembro");
    expect(resultado.district).toBe("Centro");
    expect(resultado.city).toBe("Curitiba");
    expect(resultado.state).toBe("PR");
    expect(resultado.zip_code).toBe("80000-000");
  });

  it("CEP sem bairro não apaga o bairro digitado à mão", () => {
    const resultado = comEnderecoDoCep(digitado, {
      cep: "80000000",
      city: "Curitiba",
      state: "PR",
    });
    expect(resultado.district).toBe("Bairro Digitado");
  });
});

describe("temEndereco", () => {
  it("é falso só quando os sete estão vazios", () => {
    expect(temEndereco(ENDERECO_VAZIO)).toBe(false);
    expect(temEndereco(null)).toBe(false);
    expect(temEndereco({ ...ENDERECO_VAZIO, city: "Curitiba" })).toBe(true);
  });

  it("cobre os sete campos que a tela mostra", () => {
    expect(CAMPOS_DO_ENDERECO).toEqual([
      "zip_code",
      "street",
      "number",
      "complement",
      "district",
      "city",
      "state",
    ]);
  });
});
