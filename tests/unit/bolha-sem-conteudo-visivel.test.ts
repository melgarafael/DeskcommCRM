/**
 * Bolha que só tem caractere invisível não sai (spec 28, fatia 3).
 *
 * `trim()` não tira formatação invisível (`U+200E`, `U+200B`, `U+FEFF`…): a
 * resposta da IA feita só disso passava pela trava `corpo_vazio` e chegava ao
 * cliente em branco. A régua é uma função só (`semConteudoVisivel`), usada na
 * trava e no `splitIntoBubbles`.
 */
import { describe, expect, it } from "vitest";

import { semConteudoVisivel } from "@/lib/agent-engine/agent/conteudo-visivel";
import { splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

describe("semConteudoVisivel", () => {
  it("vazio, espaço e quebra de linha não têm conteúdo visível", () => {
    expect(semConteudoVisivel("")).toBe(true);
    expect(semConteudoVisivel("   \n\t ")).toBe(true);
  });

  it("caractere de formatação invisível sozinho não tem conteúdo visível", () => {
    expect(semConteudoVisivel("‎")).toBe(true); // marca de direção (caso medido em 26/10)
    expect(semConteudoVisivel("​\n ⁠")).toBe(true); // largura zero + word joiner
    expect(semConteudoVisivel("﻿")).toBe(true); // BOM
  });

  it("texto com letra ou emoji é conteúdo", () => {
    expect(semConteudoVisivel("ok")).toBe(false);
    expect(semConteudoVisivel("👍")).toBe(false);
    expect(semConteudoVisivel("‎ ok")).toBe(false);
  });

  it("trim() sozinho NÃO basta: a régua existe porque o trim deixa o U+200E passar", () => {
    expect("‎".trim()).toBe("‎");
    expect(semConteudoVisivel("‎".trim())).toBe(true);
  });
});

describe("splitIntoBubbles — nunca devolve bolha invisível", () => {
  it("corpo só com caractere invisível não gera bolha", () => {
    expect(splitIntoBubbles("‎", 600)).toEqual([]);
    expect(splitIntoBubbles("​\n\n﻿", 600)).toEqual([]);
  });

  it("parágrafo invisível entre dois visíveis é descartado; a ordem dos outros se mantém", () => {
    const out = splitIntoBubbles("Primeiro.\n\n‎\n\nSegundo.", 600);
    expect(out).toEqual(["Primeiro.", "Segundo."]);
  });

  it("pedaço invisível de parágrafo longo não vira bolha sozinha", () => {
    const out = splitIntoBubbles("Uma frase bem comprida sobre o pedido. ‎", 25);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((b) => !semConteudoVisivel(b))).toBe(true);
  });
});
