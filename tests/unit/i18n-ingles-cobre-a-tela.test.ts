import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

import { AREAS_DE_PRODUTO, buracosDeTraducao, varrerChavesDeI18n } from "./helpers/chave-dinamica";

/**
 * O INGLÊS COBRE A TELA — espelho do guarda do espanhol.
 *
 * ─── Por que um espelho, e não um parâmetro ────────────────────────────────
 *
 * O guarda do espanhol (`i18n-espanhol-cobre-a-tela.test.ts`) prova três coisas:
 * que nenhuma entrada declara `pt-BR`, que toda chave usada tem tradução, e
 * que nenhuma prosa em português escapa de `t()`. Duas delas são agnósticas ao
 * idioma de destino — a prosa portuguesa fora de `t()` vaza para QUALQUER
 * idioma, e a chave que declara `pt-BR` muda o português de todo mundo.
 *
 * O que é próprio do inglês e mora aqui:
 *
 *   1. **O dicionário está 100% em inglês.** Mais forte que "toda chave usada":
 *      com o dicionário inteiro traduzido, nenhuma chamada `t()` — estática
 *      ou dinâmica — cai no português por falta de inglês.
 *   2. **Nenhum placeholder se perde.** `{data}` que some da frase deixa o
 *      `.replace` sem alvo e a tela mostra `{data}` cru.
 *   3. **Chave dinâmica resolvida de tabela** também tem inglês, pela mesma
 *      varredura compartilhada do espanhol.
 */

const PLACEHOLDER = /\{\{?[A-Za-z_][A-Za-z0-9_]*\}?\}/g;
const placeholders = (texto: string) => (texto.match(PLACEHOLDER) ?? []).sort();

const temIngles = (chave: string): boolean => {
  const en = DICIONARIO[chave]?.en;
  return typeof en === "string" && en.trim() !== "";
};

const COMO_CONSERTAR =
  'Conserto: a coluna `en` em lib/i18n/dicionario.ts, no formato "texto em português": { es: "...", en: "English text" }. ' +
  "Confira com: pnpm test:unit tests/unit/i18n-ingles-cobre-a-tela.test.ts";

describe("o dicionário está 100% em inglês", () => {
  it("toda entrada tem inglês não vazio", () => {
    const semIngles = Object.keys(DICIONARIO).filter((chave) => !temIngles(chave));
    expect(
      semIngles,
      `${semIngles.length} entrada(s) sem inglês: quem escolheu inglês vê isto em português. ${COMO_CONSERTAR}`,
    ).toEqual([]);
  });

  it("nenhuma tradução perde ou inventa placeholder", () => {
    const divergentes = Object.entries(DICIONARIO)
      .filter(
        ([chave, v]) =>
          typeof v.en === "string" && placeholders(chave).join() !== placeholders(v.en).join(),
      )
      .map(([chave, v]) => `${JSON.stringify(chave)} → ${JSON.stringify(v.en)}`);
    expect(
      divergentes,
      `${divergentes.length} tradução(ões) com placeholder diferente da chave: o .replace fica sem alvo. ${COMO_CONSERTAR}`,
    ).toEqual([]);
  });
});

describe("chave dinâmica: o valor que sai de tabela também tem de ter inglês", () => {
  /**
   * Uma varredura só para o `describe` inteiro: cada uma lê e parseia centenas
   * de arquivos, e repetir por `it()` seria caro sem cobrar nada a mais.
   */
  const varredura = varrerChavesDeI18n(AREAS_DE_PRODUTO);
  const buracos = buracosDeTraducao(varredura, temIngles);

  it("a varredura enxerga de verdade — o verde abaixo não é vacuidade", () => {
    expect(
      varredura.arquivosVarridos,
      "nenhum arquivo varrido: o caminho das áreas mudou?",
    ).toBeGreaterThan(300);
    expect(
      varredura.dinamicos.length,
      "nenhuma chave dinâmica resolvida: a regra deixou de casar com o produto",
    ).toBeGreaterThan(50);
  });

  it("nenhum valor de chave dinâmica cai no português", () => {
    const lista = buracos.map(
      (b) => `${b.locais.join(" ")} → ${JSON.stringify(b.chave)}\n      ${b.procedencia}`,
    );
    expect(
      lista,
      `${lista.length} valor(es) de chave dinâmica sem inglês: quem escolheu inglês vê isto em português. ${COMO_CONSERTAR}`,
    ).toEqual([]);
  });
});
