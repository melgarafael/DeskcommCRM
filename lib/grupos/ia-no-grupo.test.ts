import { describe, expect, it } from "vitest";

import { grupoLiberaIa } from "./ia-no-grupo";

/**
 * #2729 — a chave POR GRUPO "Permitir que a IA responda neste grupo".
 *
 * A regra inteira cabe aqui e é propositalmente estreita: libera quem mandou
 * `true` na linha do banco, e só isso. O default da coluna é `false`, então o
 * estado de quem nunca mexeu em nada é "IA calada em grupo", que é o
 * comportamento de sempre — e `null` (linha anterior à migration) entra no
 * mesmo balde de "não sei se liberaram".
 */
describe("grupoLiberaIa", () => {
  it("libera apenas quando a chave está explicitamente ligada", () => {
    expect(grupoLiberaIa(true)).toBe(true);
  });

  it("falha fechada: todo o resto é não responde", () => {
    const casos: [unknown, string][] = [
      [false, "desligada"],
      [null, "coluna nula (linha anterior à migration)"],
      [undefined, "coluna nem veio no SELECT"],
      [0, "zero"],
      ["true", "texto 'true'"],
      ["sim", "texto 'sim'"],
      [{}, "objeto"],
      [NaN, "NaN"],
    ];
    for (const [valor, rotulo] of casos) {
      expect(grupoLiberaIa(valor), rotulo).toBe(false);
    }
  });
});
