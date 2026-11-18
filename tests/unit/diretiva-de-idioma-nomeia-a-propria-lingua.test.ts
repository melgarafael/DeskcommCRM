import { describe, expect, it } from "vitest";

import { diretivaDeIdioma } from "@/lib/agent-engine/agent/idioma-do-turno";
import { IDIOMAS } from "@/lib/i18n/idiomas";

/**
 * A DIRETIVA DE IDIOMA DIZ A LÍNGUA DA PRÓPRIA ORGANIZAÇÃO.
 *
 * A diretiva ("Esta organização atende em português (Brasil)…") é uma frase
 * que cada idioma ADAPTA, e não traduz: o espanhol diz "atiende en español".
 * A primeira versão do catálogo em inglês a traduziu ao pé da letra — "This
 * organization serves customers in Portuguese (Brazil)" —, e todo turno de
 * uma organização em inglês passou a dizer ao modelo que a empresa trabalha em
 * português. Medido numa instalação real (16/11/2026): os registros que a IA
 * escreve para a equipe saíam em português.
 */
const ATENDE_EM: Record<string, RegExp> = {
  es: /atiende en español/,
  en: /serves customers in English/,
};

describe("a diretiva de idioma nomeia a língua da própria organização", () => {
  it.each(IDIOMAS.filter((idioma) => idioma !== "pt-BR"))("%s", (idioma) => {
    const esperado = ATENDE_EM[idioma];
    expect(esperado, `falta em ATENDE_EM a frase de "${idioma}": o idioma novo precisa ADAPTAR a diretiva`).toBeTruthy();
    const diretiva = diretivaDeIdioma(idioma);
    expect(diretiva).toMatch(esperado as RegExp);
    expect(diretiva).not.toMatch(/Portuguese \(Brazil\)|português \(Brasil\)/);
  });
});
