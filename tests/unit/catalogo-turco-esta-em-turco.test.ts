/**
 * O CATÁLOGO TURCO ESTÁ EM TURCO — e não em português com outra extensão.
 *
 * A guarda de completude (`i18n-espanhol-cobre-a-tela`) conta se toda chave tem
 * valor; ela fica verde com um catálogo que copiou o português para o valor.
 * Esta conta o que ela não vê: letra que só o português usa, e valor igual à
 * chave além do que o turco de fato mantém (marca, sigla, número).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const CATALOGO = JSON.parse(readFileSync(join(RAIZ, "lib", "i18n", "traducoes", "tr.json"), "utf8")) as Record<
  string,
  string
>;

/** Os nomes que não se traduzem, lidos do próprio glossário: uma lista só. */
function nomesQueNaoSeTraduzem(): Set<string> {
  const glossario = readFileSync(join(RAIZ, "docs", "i18n", "tr-sozluk.md"), "utf8");
  const secao = glossario.split(/^## /m).find((parte) => parte.startsWith("Çevrilmeyecek adlar"));
  const linha = secao?.split("\n").find((l) => l.includes(",")) ?? "";
  return new Set(linha.split(",").map((nome) => nome.trim()).filter(Boolean));
}

describe("o catálogo turco", () => {
  const nomes = nomesQueNaoSeTraduzem();

  it("o glossário lista os nomes que não se traduzem — a régua abaixo não é vazia", () => {
    expect(nomes.has("WhatsApp")).toBe(true);
    expect(nomes.size).toBeGreaterThanOrEqual(12);
  });

  it("nenhum valor carrega letra que só o português usa", () => {
    const portugues = Object.entries(CATALOGO)
      .filter(([, valor]) => /[ãõáéíóúàê]/i.test(valor))
      .map(([chave, valor]) => `${JSON.stringify(chave)} → ${JSON.stringify(valor)}`);
    expect(portugues, `${portugues.length} valor(es) com letra portuguesa`).toEqual([]);
  });

  it("menos de 2% dos valores ficaram iguais à chave", () => {
    const contaveis = Object.entries(CATALOGO).filter(
      ([chave, valor]) => /\p{L}/u.test(chave) && chave.trim().length > 3 && !nomes.has(valor.trim()),
    );
    const iguais = contaveis.filter(([chave, valor]) => chave === valor);
    const amostra = iguais.slice(0, 20).map(([chave]) => JSON.stringify(chave));
    expect(
      iguais.length / Math.max(contaveis.length, 1),
      `${iguais.length} de ${contaveis.length} valores iguais à chave; os primeiros: ${amostra.join(", ")}`,
    ).toBeLessThan(0.02);
  });
});
