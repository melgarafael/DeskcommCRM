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
