import { describe, expect, it } from "vitest";

import { filtrarAgentes } from "./filtrar-agentes";

const AGENTES = [
  { id: "1", name: "Atendimento Pós-venda" },
  { id: "2", name: "Vendas" },
  { id: "3", name: "Suporte Técnico" },
  { id: "4", name: "Begoña Müller" },
  { id: "5", name: "Øyvind Strauß" },
];

describe("busca da lista de agentes", () => {
  it("acha o agente digitando sem acento (#4165)", () => {
    expect(filtrarAgentes(AGENTES, "pos-venda")).toEqual([
      { id: "1", name: "Atendimento Pós-venda" },
    ]);
    expect(filtrarAgentes(AGENTES, "atendimento pos").map((a) => a.id)).toEqual(["1"]);
  });

  it("continua ignorando caixa dos dois lados", () => {
    expect(filtrarAgentes(AGENTES, "VENDAS").map((a) => a.id)).toEqual(["2"]);
    expect(filtrarAgentes(AGENTES, "vendas").map((a) => a.id)).toEqual(["2"]);
  });

  it("termo com acento também acha o nome sem acento", () => {
    expect(filtrarAgentes(AGENTES, "técnico").map((a) => a.id)).toEqual(["3"]);
  });

  it("nomes com caracteres que o NFD sozinho não decompõe", () => {
    expect(filtrarAgentes(AGENTES, "oyvind").map((a) => a.id)).toEqual(["5"]);
    expect(filtrarAgentes(AGENTES, "begoña").map((a) => a.id)).toEqual(["4"]);
  });

  it("termo vazio devolve a lista inteira, na ordem recebida", () => {
    expect(filtrarAgentes(AGENTES, "")).toBe(AGENTES);
    expect(filtrarAgentes(AGENTES, "   ")).toBe(AGENTES);
  });

  it("devolve lista vazia quando nada casa", () => {
    expect(filtrarAgentes(AGENTES, "zzz")).toEqual([]);
  });
});
