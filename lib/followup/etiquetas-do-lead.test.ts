import { describe, expect, it } from "vitest";

import { etiquetasDoLead } from "./etiquetas-do-lead";

/**
 * A régua da união das duas caixas de etiqueta (#4586), medida sozinha e sem banco.
 *
 * A campanha de prospecção grava a etiqueta do nicho no CONTATO; o card que ela
 * cria nasce sem etiqueta. A condição «Etiqueta do contato» perguntava só ao
 * card. Aqui fica congelado o que a condição passa a enxergar: as duas caixas.
 */

describe("etiquetasDoLead", () => {
  it("junta a etiqueta do negócio com a do contato — a da campanha não some", () => {
    expect(etiquetasDoLead(["vip"], ["dentista"])).toEqual(["vip", "dentista"]);
  });

  it("não repete a mesma etiqueta nas duas caixas", () => {
    expect(etiquetasDoLead(["dentista"], ["dentista"])).toEqual(["dentista"]);
  });

  it("card sem etiqueta e contato etiquetado pela campanha devolve a do contato", () => {
    expect(etiquetasDoLead([], ["dentista"])).toEqual(["dentista"]);
  });

  it("contato antigo sem `tags` não quebra nem inventa etiqueta", () => {
    expect(etiquetasDoLead(["vip"], null)).toEqual(["vip"]);
    expect(etiquetasDoLead(undefined, undefined)).toEqual([]);
    expect(etiquetasDoLead(null, [])).toEqual([]);
  });

  it("descarta vazio e o que não é texto em vez de propagar para a comparação", () => {
    expect(etiquetasDoLead([""], ["dentista", null as unknown as string])).toEqual(["dentista"]);
  });
});
