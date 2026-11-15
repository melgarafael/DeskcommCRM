import { describe, expect, it } from "vitest";

import { filtrarAgentes } from "./filtrar-agentes";

const AGENTES = [
  { name: "Atendimento Pós-venda" },
  { name: "Pós Venda" },
  { name: "Suporte técnico" },
  { name: "Financeiro" },
];

const nomes = (termo: string) => filtrarAgentes(AGENTES, termo).map((a) => a.name);

describe('Agentes: "pos-venda" acha "Pós-venda" (#4165)', () => {
  it("sem acento, o agente acentuado continua na lista", () => {
    expect(nomes("pos-venda")).toEqual(["Atendimento Pós-venda"]);
  });

  it("em maiúsculas sem acento, acha a variante escrita com espaço", () => {
    expect(nomes("PÓS VENDA")).toEqual(["Pós Venda"]);
  });

  it("com o acento digitado, o resultado é o mesmo", () => {
    expect(nomes("pós-venda")).toEqual(["Atendimento Pós-venda"]);
  });

  it("termo que não existe devolve lista vazia", () => {
    expect(nomes("juridico")).toEqual([]);
  });

  it("termo vazio devolve a lista inteira, na mesma referência", () => {
    expect(filtrarAgentes(AGENTES, "")).toBe(AGENTES);
    expect(filtrarAgentes(AGENTES, "   ")).toBe(AGENTES);
  });

  it("acha no meio do nome, não só no começo", () => {
    expect(nomes("venda")).toEqual(["Atendimento Pós-venda", "Pós Venda"]);
  });
});

const COM_DESCRICAO = [
  { name: "Kelly", description: "Retomada de pré-vendas por WhatsApp" },
  { name: "Suporte técnico", description: null },
  { name: "Financeiro", description: "Cobrança e segunda via de boleto" },
  { name: "Sem descrição" },
];

const achados = (termo: string) => filtrarAgentes(COM_DESCRICAO, termo).map((a) => a.name);

describe("Agentes: o termo casa também com a descrição (#4593)", () => {
  it("termo que só existe na descrição encontra o agente", () => {
    expect(achados("boleto")).toEqual(["Financeiro"]);
  });

  it("a descrição usa a mesma régua do nome: sem acento e sem caixa", () => {
    expect(achados("pre-vendas")).toEqual(["Kelly"]);
    expect(achados("cobranca")).toEqual(["Financeiro"]);
    expect(achados("SEGUNDA VIA")).toEqual(["Financeiro"]);
  });

  it("termo que existe no nome continua encontrando", () => {
    expect(achados("kelly")).toEqual(["Kelly"]);
    expect(achados("financeiro")).toEqual(["Financeiro"]);
  });

  it("termo inexistente devolve lista vazia", () => {
    expect(achados("juridico")).toEqual([]);
  });

  it("descrição nula ou ausente não derruba a função", () => {
    expect(() => filtrarAgentes(COM_DESCRICAO, "suporte")).not.toThrow();
    expect(achados("suporte")).toEqual(["Suporte técnico"]);
    expect(achados("sem descricao")).toEqual(["Sem descrição"]);
  });
});
