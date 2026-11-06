import { describe, expect, it } from "vitest";

import { filtrarOpcoes } from "./filtrar-opcoes";

const OPCOES = [
  { value: "t1", label: "Clínica Aurora (aurora)" },
  { value: "t2", label: "Padaria Conceição (conceicao)" },
  { value: "t3", label: "Loja Central (central)" },
];

describe("filtro de opções da auditoria", () => {
  it("acha a empresa com acento digitada sem acento (#4168)", () => {
    expect(filtrarOpcoes(OPCOES, "clinica").map((o) => o.value)).toEqual(["t1"]);
    expect(filtrarOpcoes(OPCOES, "conceicao").map((o) => o.value)).toEqual(["t2"]);
  });

  it("ignora a caixa dos dois lados", () => {
    expect(filtrarOpcoes(OPCOES, "CLÍNICA").map((o) => o.value)).toEqual(["t1"]);
    expect(filtrarOpcoes(OPCOES, "loja").map((o) => o.value)).toEqual(["t3"]);
  });

  it("termo vazio devolve a lista inteira, na ordem recebida", () => {
    expect(filtrarOpcoes(OPCOES, "")).toBe(OPCOES);
    expect(filtrarOpcoes(OPCOES, "   ")).toBe(OPCOES);
  });

  it("devolve lista vazia quando nada casa", () => {
    expect(filtrarOpcoes(OPCOES, "zzz")).toEqual([]);
  });
});
