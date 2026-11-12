import { describe, expect, it } from "vitest";

import { filtrarNegocios } from "./filtrar-negocios";

const contato = (name: string | null, phone_number: string | null = null) => ({
  name,
  display_name: null,
  phone_number,
});

const NEGOCIOS = [
  { id: "1", title: "Reforma da cozinha", contact: contato("João Conceição") },
  { id: "2", title: "Instalação elétrica", contact: contato("Maria") },
  { id: "3", title: null, contact: contato(null, "5511999999999") },
  { id: "4", title: "Pintura", contact: null },
];

describe("busca de negócio da nova proposta", () => {
  it("acha João Conceição quando se digita joao (#4413)", () => {
    expect(filtrarNegocios(NEGOCIOS, "joao").map((n) => n.id)).toEqual(["1"]);
    expect(filtrarNegocios(NEGOCIOS, "conceicao").map((n) => n.id)).toEqual(["1"]);
  });

  it("acha Instalação elétrica quando se digita instalacao (#4413)", () => {
    expect(filtrarNegocios(NEGOCIOS, "instalacao").map((n) => n.id)).toEqual(["2"]);
    expect(filtrarNegocios(NEGOCIOS, "eletrica").map((n) => n.id)).toEqual(["2"]);
  });

  it("ignora a caixa e o acento dos dois lados", () => {
    expect(filtrarNegocios(NEGOCIOS, "JOÃO").map((n) => n.id)).toEqual(["1"]);
    expect(filtrarNegocios(NEGOCIOS, "Instalação").map((n) => n.id)).toEqual(["2"]);
  });

  it("continua achando pelo telefone", () => {
    expect(filtrarNegocios(NEGOCIOS, "9999").map((n) => n.id)).toEqual(["3"]);
  });

  it("termo vazio devolve a lista inteira, na ordem recebida", () => {
    expect(filtrarNegocios(NEGOCIOS, "")).toBe(NEGOCIOS);
    expect(filtrarNegocios(NEGOCIOS, "   ")).toBe(NEGOCIOS);
  });

  it("devolve lista vazia quando nada casa", () => {
    expect(filtrarNegocios(NEGOCIOS, "zzz")).toEqual([]);
  });
});
