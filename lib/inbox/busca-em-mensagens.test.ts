import { describe, expect, it } from "vitest";

import { partesDoTrecho, palavrasDoTermo, trechoCasado } from "./busca-em-mensagens";

/**
 * O TRECHO QUE EXPLICA A LINHA (#1355, fatia 1).
 *
 * A busca passou a casar o TEXTO da mensagem; sem o trecho, o resultado é um
 * nome de cliente solto e a pessoa abre o tique para descobrir POR QUE aquela
 * conversa apareceu — o mesmo rolar de antes, só que depois do clique.
 *
 * Estas funções são puras de propósito: o corte do trecho e o destaque são
 * decisões de apresentação que se provam sem renderizar nada e sem banco.
 */

describe("trechoCasado", () => {
  it("devolve o texto EM VOLTA do termo, não o começo da mensagem", () => {
    const corpo =
      "bom dia! tudo bem com você? então, sobre aquilo que conversamos ontem, " +
      "o orçamento da tangerina ficou combinado com o frete incluso, pode confirmar?";

    const trecho = trechoCasado(corpo, "tangerina");

    expect(trecho).toContain("tangerina");
    expect(trecho, "o trecho precisa dar contexto, não só a palavra").toContain("orçamento");
    expect(trecho!.length).toBeLessThan(corpo.length);
  });

  it("marca as reticências quando corta dos dois lados", () => {
    const corpo = `${"palavra ".repeat(60)}alvo${" palavra".repeat(60)}`;
    const trecho = trechoCasado(corpo, "alvo", 60);

    expect(trecho).toContain("alvo");
    expect(trecho!.startsWith("…")).toBe(true);
    expect(trecho!.endsWith("…")).toBe(true);
  });

  it("não começa nem termina no meio de uma palavra", () => {
    const corpo = "aaaaaaaaaa bbbbbbbbbb orçamento cccccccccc dddddddddd";
    const trecho = trechoCasado(corpo, "orçamento", 30)!;

    expect(trecho).toContain("orçamento");
    // Se o corte cair dentro de "bbbbbbbbbb", o pedaço começaria com "b" solto.
    expect(trecho.replace(/^…/, "")).toMatch(/^[a-zà-ú]+( |$)/i);
  });

  it("acha a palavra do termo mesmo com curinga e caixa diferente", () => {
    // O termo chega saneado (`termoSeguroParaOr`): separadores viram `*`.
    expect(trechoCasado("falamos de TANGERINA hoje", "pedido*tangerina")).toContain("TANGERINA");
  });

  it("corpo vazio ou nulo devolve null (não inventa trecho)", () => {
    expect(trechoCasado(null, "x")).toBeNull();
    expect(trechoCasado("   ", "x")).toBeNull();
  });
});

describe("partesDoTrecho", () => {
  it("separa o que casa do que não casa, sem perder caractere", () => {
    const trecho = "…o orçamento da tangerina…";
    const partes = partesDoTrecho(trecho, "tangerina");

    expect(partes.filter((p) => p.casa).map((p) => p.texto)).toEqual(["tangerina"]);
    expect(partes.map((p) => p.texto).join("")).toBe(trecho);
  });

  it("sem termo, o trecho sai inteiro e nada é destacado", () => {
    expect(partesDoTrecho("um texto qualquer", "")).toEqual([
      { texto: "um texto qualquer", casa: false },
    ]);
  });

  it("acha TODAS as ocorrências, não só a primeira", () => {
    const partes = partesDoTrecho("tangerina e tangerina", "tangerina");
    expect(partes.filter((p) => p.casa)).toHaveLength(2);
  });
});

describe("palavrasDoTermo", () => {
  it("quebra o termo saneado e descarta o curinga sozinho", () => {
    expect(palavrasDoTermo("pedido*tangerina")).toEqual(["pedido", "tangerina"]);
    expect(palavrasDoTermo("a*")).toEqual([]);
    expect(palavrasDoTermo("50\\%")).toEqual(["50%"]);
  });
});
