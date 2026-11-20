import { describe, expect, it } from "vitest";

import { funisQueCasam } from "./filtrar-funis";

const FUNIS = [
  { id: "f1", name: "Prospecção (Site)", slug: "prospeccao-site" },
  { id: "f2", name: "Pós-venda", slug: "pos-venda" },
  { id: "f3", name: "Locação", slug: "aluguel" },
];

const ids = (busca: string) => [...(funisQueCasam(FUNIS, busca) ?? [])];

describe("Funis: a busca da lista em Configurações (#4593)", () => {
  it("acha pelo nome, sem acento e sem caixa", () => {
    expect(ids("prospeccao")).toEqual(["f1"]);
    expect(ids("PÓS")).toEqual(["f2"]);
    expect(ids("locacao")).toEqual(["f3"]);
  });

  it("acha pelo endereço que o cartão mostra embaixo do nome", () => {
    expect(ids("aluguel")).toEqual(["f3"]);
    expect(ids("prospeccao-site")).toEqual(["f1"]);
  });

  it("termo que não existe devolve um conjunto vazio, não a lista inteira", () => {
    expect(ids("financeiro")).toEqual([]);
    expect(funisQueCasam(FUNIS, "financeiro")).not.toBeNull();
  });

  it("termo vazio (ou só espaços) não é busca: devolve null", () => {
    expect(funisQueCasam(FUNIS, "")).toBeNull();
    expect(funisQueCasam(FUNIS, "   ")).toBeNull();
  });
});
