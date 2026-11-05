import { describe, expect, it } from "vitest";

import { chaveDeBuscaDeDestino, filtrarDestinos } from "./filtrar-destinos";

const DESTINOS = [
  { id: "1", rotulo: "João" },
  { id: "2", rotulo: "Maria Conceição" },
  { id: "3", rotulo: "5511999999999" },
  { id: "4", rotulo: "Sem nome" },
];

describe("busca de destino do encaminhamento", () => {
  it("acha João quando se digita joao (#4072)", () => {
    expect(filtrarDestinos(DESTINOS, "joao")).toEqual([{ id: "1", rotulo: "João" }]);
  });

  it("ignora a caixa dos dois lados", () => {
    expect(filtrarDestinos(DESTINOS, "JOAO")).toEqual([{ id: "1", rotulo: "João" }]);
    expect(filtrarDestinos(DESTINOS, "joão").map((d) => d.id)).toEqual(["1"]);
  });

  it("acha o nome acentuado digitado sem cedilha nem til", () => {
    expect(filtrarDestinos(DESTINOS, "conceicao").map((d) => d.id)).toEqual(["2"]);
    expect(filtrarDestinos(DESTINOS, "MARIA").map((d) => d.id)).toEqual(["2"]);
  });

  it("continua achando pelo telefone", () => {
    expect(filtrarDestinos(DESTINOS, "9999").map((d) => d.id)).toEqual(["3"]);
  });

  it("termo vazio devolve a lista inteira, na ordem recebida", () => {
    expect(filtrarDestinos(DESTINOS, "")).toBe(DESTINOS);
    expect(filtrarDestinos(DESTINOS, "   ")).toBe(DESTINOS);
  });

  it("devolve lista vazia quando nada casa", () => {
    expect(filtrarDestinos(DESTINOS, "zzz")).toEqual([]);
  });
});

describe("chave de busca", () => {
  it("tira acento, caixa e mantém a comparação estável", () => {
    expect(chaveDeBuscaDeDestino("  João  ")).toBe("  joao  ");
    expect(chaveDeBuscaDeDestino("JOÃO")).toBe("joao");
  });
});
