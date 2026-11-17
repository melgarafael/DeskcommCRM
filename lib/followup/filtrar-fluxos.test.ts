import { describe, expect, it } from "vitest";

import { filtrarFluxos, type FiltroDeStatusDoFluxo } from "./filtrar-fluxos";

const FLUXOS = [
  { name: "Kelly · retomada (oficinas mecânicas)", status: "active" as const },
  { name: "Kelly · retomada (clínicas odontológicas)", status: "active" as const },
  { name: "Retomada pós-venda", status: "draft" as const },
  { name: "Boas-vindas", status: "disabled" as const },
];

const nomes = (busca: string, status: FiltroDeStatusDoFluxo = "all") =>
  filtrarFluxos(FLUXOS, { busca, status }).map((f) => f.name);

describe('Follow-ups: "oficina" deixa só o fluxo de oficinas (#4593)', () => {
  it("o termo da issue acha o fluxo pelo trecho que o cartão corta", () => {
    expect(nomes("oficina")).toEqual(["Kelly · retomada (oficinas mecânicas)"]);
  });

  it("os dois lados passam pela mesma régua: sem acento e sem caixa", () => {
    expect(nomes("MECANICA")).toEqual(["Kelly · retomada (oficinas mecânicas)"]);
    expect(nomes("pos-venda")).toEqual(["Retomada pós-venda"]);
    expect(nomes("odontológicas")).toEqual(["Kelly · retomada (clínicas odontológicas)"]);
  });

  it("acha no meio do nome e preserva a ordem recebida", () => {
    expect(nomes("retomada")).toEqual([
      "Kelly · retomada (oficinas mecânicas)",
      "Kelly · retomada (clínicas odontológicas)",
      "Retomada pós-venda",
    ]);
  });

  it("termo que não existe devolve lista vazia", () => {
    expect(nomes("imobiliaria")).toEqual([]);
  });

  it("termo vazio com todos os status devolve a lista inteira, na mesma referência", () => {
    expect(filtrarFluxos(FLUXOS, { busca: "", status: "all" })).toBe(FLUXOS);
    expect(filtrarFluxos(FLUXOS, { busca: "   ", status: "all" })).toBe(FLUXOS);
  });
});

describe("Follow-ups: filtro por status (#4593)", () => {
  it("sem termo, recorta só pelo status", () => {
    expect(nomes("", "draft")).toEqual(["Retomada pós-venda"]);
    expect(nomes("", "disabled")).toEqual(["Boas-vindas"]);
  });

  it("com termo, procura dentro do recorte do status", () => {
    expect(nomes("retomada", "active")).toEqual([
      "Kelly · retomada (oficinas mecânicas)",
      "Kelly · retomada (clínicas odontológicas)",
    ]);
    expect(nomes("retomada", "draft")).toEqual(["Retomada pós-venda"]);
    expect(nomes("boas", "active")).toEqual([]);
  });
});
