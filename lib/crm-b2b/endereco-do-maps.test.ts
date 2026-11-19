/**
 * O endereço do Maps nas colunas da Empresa (#3198, fatia 3).
 *
 * O que estes testes fixam: o parser só devolve campo quando o texto bate com o
 * formato brasileiro padrão, e devolve `{}` — nunca um palpite — quando não bate.
 */
import { describe, expect, it } from "vitest";

import { enderecoDoMaps } from "@/lib/crm-b2b/endereco-do-maps";

describe("enderecoDoMaps", () => {
  it("separa o formato completo: rua, número, bairro, cidade, UF e CEP", () => {
    expect(enderecoDoMaps("R. Augusta, 1234 - Consolação, São Paulo - SP, 01304-001")).toEqual({
      street: "R. Augusta",
      number: "1234",
      district: "Consolação",
      city: "São Paulo",
      state: "SP",
      zip_code: "01304-001",
    });
  });

  it("aceita o país no fim e o CEP sem hífen", () => {
    expect(
      enderecoDoMaps("Av. Brasil, 10 - Centro, Curitiba - PR, 80010000, Brasil"),
    ).toEqual({
      street: "Av. Brasil",
      number: "10",
      district: "Centro",
      city: "Curitiba",
      state: "PR",
      zip_code: "80010-000",
    });
  });

  it("aceita endereço sem CEP", () => {
    expect(enderecoDoMaps("Rua A, 5 - Boa Vista, Recife - PE")).toEqual({
      street: "Rua A",
      number: "5",
      district: "Boa Vista",
      city: "Recife",
      state: "PE",
    });
  });

  it("o que vem entre o número e o bairro é complemento", () => {
    expect(
      enderecoDoMaps("Rua B, 200 - Sala 12 - Centro, Belo Horizonte - MG, 30110-000"),
    ).toEqual({
      street: "Rua B",
      number: "200",
      complement: "Sala 12",
      district: "Centro",
      city: "Belo Horizonte",
      state: "MG",
      zip_code: "30110-000",
    });
  });

  it("aceita 's/n' como número", () => {
    expect(enderecoDoMaps("Estrada X, s/n - Zona Rural, Goiânia - GO")).toMatchObject({
      street: "Estrada X",
      number: "S/N",
      district: "Zona Rural",
    });
  });

  it("sem número, devolve só cidade, estado e CEP — não adivinha a rua", () => {
    expect(enderecoDoMaps("Av. Paulista - Bela Vista, São Paulo - SP, 01310-100")).toEqual({
      city: "São Paulo",
      state: "SP",
      zip_code: "01310-100",
    });
  });

  it("UF que não existe não é aceita", () => {
    expect(enderecoDoMaps("Rua A, 5 - Centro, Cidade - XX")).toEqual({});
  });

  it("texto que não parece endereço do Maps devolve vazio", () => {
    expect(enderecoDoMaps("perto da praça, ao lado do mercado")).toEqual({});
    expect(enderecoDoMaps("")).toEqual({});
    expect(enderecoDoMaps(null)).toEqual({});
    expect(enderecoDoMaps(undefined)).toEqual({});
  });

  it("endereço estrangeiro não vira endereço brasileiro", () => {
    expect(enderecoDoMaps("221B Baker Street, London NW1 6XE, UK")).toEqual({});
  });
});
