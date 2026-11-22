import { describe, expect, it } from "vitest";

import { csvDasLinhasDeFora, type Previa } from "@/app/app/imports/_client";

/**
 * O CSV "o que ficou de fora" da importação segue a regra de todo export do
 * produto (`lib/csv/neutralizar-formula.ts`): célula que começa como fórmula
 * sai como texto. O nome do cadastro existente e as células da planilha vêm de
 * terceiros.
 */
const t = (s: string) => s;

function previa(existente: string, valor: string): Previa {
  return {
    headers: ["nome"],
    linhas_fora: [
      { linha: 2, status: "ja_existe", motivo: null, existente_nome: existente, de_quem: null, valores: [valor] },
    ],
  } as unknown as Previa;
}

describe("CSV das linhas de fora da importação", () => {
  it("célula que começa com = vira texto, no nome existente e na planilha", () => {
    const csv = csvDasLinhasDeFora(previa("=1+1", "+2+3"), t);
    expect(csv).toContain(`"'=1+1"`);
    expect(csv).toContain(`"'+2+3"`);
  });

  it("controle: texto comum e número saem iguais", () => {
    const csv = csvDasLinhasDeFora(previa("Maria Souza", "-15"), t);
    expect(csv).toContain(`"Maria Souza"`);
    expect(csv).toContain(`"-15"`);
  });
});
