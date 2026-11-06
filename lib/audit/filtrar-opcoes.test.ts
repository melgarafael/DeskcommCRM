import { describe, expect, it } from "vitest";

import { filtrarOpcoes } from "./filtrar-opcoes";

const OPCOES = [
  { value: "t1", label: "Exclusão Fiscal" },
  { value: "t2", label: "Clínica São João" },
  { value: "t3", label: "lgpd.exportacao" },
];

const valores = (termo: string) => filtrarOpcoes(OPCOES, termo).map((o) => o.value);

describe('Auditoria: "exclusao" acha "Exclusão" (#4168)', () => {
  it("sem acento, a empresa acentuada continua no filtro", () => {
    expect(valores("exclusao")).toEqual(["t1"]);
  });

  it("em maiúsculas sem acento também acha", () => {
    expect(valores("EXCLUSAO")).toEqual(["t1"]);
  });

  it("com o acento digitado, o resultado é o mesmo", () => {
    expect(valores("Exclusão")).toEqual(["t1"]);
  });

  it("acha acento no meio do rótulo", () => {
    expect(valores("sao joao")).toEqual(["t2"]);
  });

  it("os códigos de ação em ASCII continuam sendo achados", () => {
    expect(valores("lgpd.exportacao")).toEqual(["t3"]);
    expect(valores("EXPORTACAO")).toEqual(["t3"]);
  });

  it("termo que não existe devolve lista vazia", () => {
    expect(valores("inclusao")).toEqual([]);
  });

  it("termo vazio devolve a lista inteira, na mesma referência", () => {
    expect(filtrarOpcoes(OPCOES, "")).toBe(OPCOES);
    expect(filtrarOpcoes(OPCOES, "  ")).toBe(OPCOES);
  });
});
