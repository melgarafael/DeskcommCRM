import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { NAV_CATALOG, NAV_GROUPS } from "@/lib/navigation/catalogo";

/**
 * O CATÁLOGO DO MENU TAMBÉM FALA ESPANHOL.
 *
 * `i18n-espanhol-cobre-a-tela.test.ts` cobra os `t("…")` do JSX, mas o texto do
 * menu mora em `lib/navigation/catalogo.ts` (`label`, `description`, `section`)
 * e chega à tela por `traduzir(item.description, idioma)` — um acesso a
 * propriedade de uma variável de laço, que a varredura de chaves não resolve.
 * Resultado medido em v1.41.0: a descrição de "Financeiro" saía em português
 * para quem escolheu espanhol, com todos os testes verdes.
 *
 * Aqui o catálogo é lido de verdade (é dado, não JSX), então não há o que
 * adivinhar: todo texto que a navegação mostra precisa ter a coluna `es`.
 */

const temEspanhol = (texto: string): boolean => Boolean(DICIONARIO[texto]?.es);

interface TextoDoMenu {
  readonly onde: string;
  readonly campo: string;
  readonly texto: string;
}

function textosDoMenu(): TextoDoMenu[] {
  const achados: TextoDoMenu[] = [];
  const junta = (onde: string, item: Record<string, unknown>, campos: readonly string[]) => {
    for (const campo of campos) {
      const texto = item[campo];
      if (typeof texto === "string" && texto.trim() !== "") achados.push({ onde, campo, texto });
    }
  };
  for (const item of NAV_CATALOG as readonly Record<string, unknown>[]) {
    junta(String(item.href), item, ["label", "description", "section"]);
  }
  for (const grupo of NAV_GROUPS as unknown as readonly Record<string, unknown>[]) {
    junta(`grupo:${String(grupo.id)}`, grupo, ["label", "description"]);
  }
  return achados;
}

/**
 * A dívida de HOJE, congelada — um par (destino, campo) por linha. SÓ ENCOLHE:
 * traduzir a linha faz a entrada deixar de casar, e o segundo teste fica
 * vermelho pedindo a remoção daqui. Entrada nova precisa do argumento escrito, e
 * ele nunca é "não deu tempo".
 *
 * Zerada em 20/09/2026: as cinco descrições e a seção que faltavam ganharam espanhol.
 */
const DIVIDA_CONGELADA: { onde: string; campo: string; motivo: string }[] = [];

const ehDividaCongelada = (t: TextoDoMenu): boolean =>
  DIVIDA_CONGELADA.some((d) => d.onde === t.onde && d.campo === t.campo);

describe("o catálogo do menu tem espanhol", () => {
  const textos = textosDoMenu();
  const buracos = textos.filter((t) => !temEspanhol(t.texto));

  it("leu o catálogo de verdade (não é vacuidade)", () => {
    expect(textos.length, "o catálogo do menu deixou de ter texto a cobrar").toBeGreaterThan(100);
  });

  it("todo texto do menu tem espanhol, fora da dívida congelada", () => {
    const foraDaLista = buracos
      .filter((t) => !ehDividaCongelada(t))
      .map((t) => `${t.onde} [${t.campo}] → ${JSON.stringify(t.texto)}`);
    expect(
      foraDaLista,
      `${foraDaLista.length} texto(s) do menu sem espanhol: quem escolheu espanhol vê isto em português. ` +
        'Conserto: uma linha em lib/i18n/dicionario.ts — "texto em português": { es: "texto en español" }.',
    ).toEqual([]);
  });

  it("a dívida congelada só encolhe: entrada que deixou de casar é vermelho", () => {
    const pagas = DIVIDA_CONGELADA.filter(
      (d) => !buracos.some((t) => t.onde === d.onde && t.campo === d.campo),
    ).map((d) => `${d.onde} [${d.campo}] (motivo declarado: ${d.motivo})`);
    expect(
      pagas,
      `${pagas.length} entrada(s) da DIVIDA_CONGELADA não casam mais com buraco nenhum: ` +
        "o texto foi traduzido ou mudou. Remova a entrada deste arquivo — a lista só encolhe.",
    ).toEqual([]);
  });
});
