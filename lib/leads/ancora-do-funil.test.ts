/**
 * A ÂNCORA DA URL → O FUNIL QUE DEVE ABRIR (#4083).
 *
 * Com os cards recolhidos, `#etapas-<id>` e `#mapeamento-<id>` são o caminho de
 * quem chega por link (da etapa para o mapeamento, ou de um favorito salvo). O
 * parse é a parte que erra, então ele é função pura: hash de outra tela, hash
 * vazio e hash de funil que não existe na organização não podem abrir o card
 * errado.
 */
import { describe, expect, it } from "vitest";

import { funilDaAncora } from "./ancora-do-funil";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUNIS = [A, B];

describe("funilDaAncora (#4083)", () => {
  it("reconhece a âncora das etapas e a do mapeamento", () => {
    expect(funilDaAncora(`#etapas-${A}`, FUNIS)).toBe(A);
    expect(funilDaAncora(`#mapeamento-${B}`, FUNIS)).toBe(B);
  });

  it("aceita hash sem `#` e com `#` repetido — é o que a barra de endereço entrega", () => {
    expect(funilDaAncora(`etapas-${A}`, FUNIS)).toBe(A);
    expect(funilDaAncora(`##mapeamento-${A}`, FUNIS)).toBe(A);
  });

  it("hash de outra tela, vazio ou de funil inexistente não abre nada", () => {
    expect(funilDaAncora("", FUNIS)).toBeNull();
    expect(funilDaAncora("#", FUNIS)).toBeNull();
    expect(funilDaAncora(null, FUNIS)).toBeNull();
    expect(funilDaAncora("#secao-qualquer", FUNIS)).toBeNull();
    expect(funilDaAncora(`#etapas-${"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}`, FUNIS)).toBeNull();
  });

  it("não confunde prefixo: `etapas-<id>` não casa um id que só começa igual", () => {
    expect(funilDaAncora(`#etapas-${A}-antigo`, FUNIS)).toBeNull();
  });
});
