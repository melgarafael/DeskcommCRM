import { describe, expect, it } from "vitest";

import { filtrarLigacoes } from "./filtrar-ligacoes";

const LIGACOES = [
  { id: "1", titulo: "Padaria São João", telefone: "+551199998765" },
  { id: "2", titulo: "Mercado Central", telefone: "+551191112222" },
  { id: "3", titulo: "Clínica Conceição", telefone: null },
];

const ids = (termo: string) => filtrarLigacoes(LIGACOES, termo).map((l) => l.id);

describe('Cold call: "sao joao" acha "São João" (#4167)', () => {
  it("sem acento, o negócio acentuado continua na fila", () => {
    expect(ids("sao joao")).toEqual(["1"]);
  });

  it("em maiúsculas sem acento também acha", () => {
    expect(ids("SAO JOAO")).toEqual(["1"]);
  });

  it("com o acento digitado, o resultado é o mesmo", () => {
    expect(ids("São João")).toEqual(["1"]);
  });

  it("acha o nome acentuado digitado sem cedilha nem til", () => {
    expect(ids("conceicao")).toEqual(["3"]);
  });

  it("o telefone continua achando pelo trecho digitado", () => {
    expect(ids("8765")).toEqual(["1"]);
    expect(ids("+551191112222")).toEqual(["2"]);
  });

  it("lead sem telefone não quebra a busca", () => {
    expect(filtrarLigacoes(LIGACOES, "clinica").map((l) => l.telefone)).toEqual([null]);
  });

  it("termo que não existe devolve lista vazia", () => {
    expect(ids("farmacia")).toEqual([]);
  });

  it("termo vazio devolve a lista inteira, na mesma referência", () => {
    expect(filtrarLigacoes(LIGACOES, "")).toBe(LIGACOES);
    expect(filtrarLigacoes(LIGACOES, "  ")).toBe(LIGACOES);
  });
});
