import { describe, it, expect } from "vitest";

import {
  parseReaisToCents,
  formatCentsBRL,
  formatCents,
  MOEDAS_SERVIDAS,
  MOEDA_PADRAO,
  simboloDaMoeda,
  formatValorDoNegocio,
} from "./money";

describe("parseReaisToCents", () => {
  it("lê ponto como decimal quando o grupo final não é de milhar", () => {
    // O defeito que originou este arquivo: "249.90" virava 2499000 centavos
    // (R$ 24.990,00) porque todo ponto era descartado como separador de milhar.
    expect(parseReaisToCents("249.90")).toBe(24990);
    expect(parseReaisToCents("1234.5")).toBe(123450);
    expect(parseReaisToCents("0.99")).toBe(99);
  });

  it("lê vírgula como decimal (pt-BR)", () => {
    expect(parseReaisToCents("249,90")).toBe(24990);
    expect(parseReaisToCents("1.234,56")).toBe(123456);
    expect(parseReaisToCents("1.234.567,89")).toBe(123456789);
  });

  it("trata ponto seguido de 3 dígitos como milhar", () => {
    expect(parseReaisToCents("1.234")).toBe(123400);
    expect(parseReaisToCents("1.234.567")).toBe(123456700);
  });

  it("aceita o formato en quando o último separador é o ponto", () => {
    expect(parseReaisToCents("1,234.56")).toBe(123456);
  });

  it("lê número simples", () => {
    expect(parseReaisToCents("250")).toBe(25000);
    expect(parseReaisToCents(" 250 ")).toBe(25000);
  });

  it("devolve null para o que não é valor", () => {
    expect(parseReaisToCents("")).toBeNull();
    expect(parseReaisToCents("abc")).toBeNull();
    expect(parseReaisToCents("R$ 10")).toBeNull();
    expect(parseReaisToCents("-5")).toBeNull();
  });
});

describe("formatCentsBRL", () => {
  it("mostra em reais o que está guardado em centavos", () => {
    expect(formatCentsBRL(24990).replace(/ /g, " ")).toBe("R$ 249,90");
    expect(formatCentsBRL(0).replace(/ /g, " ")).toBe("R$ 0,00");
  });
});

/** Os espaços que o `Intl` emite são NBSP (U+00A0) ou narrow NBSP (U+202F). */
const semNbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

describe("formatCents", () => {
  /**
   * ⚠️ Quem escolhe o locale do FORMATO é a MOEDA, não o idioma de quem lê.
   *
   * Parecia natural reusar `tagDeIdioma()` — o mesmo `es` que a interface já
   * resolve. Medido, não deduzido:
   *
   *     Intl.NumberFormat("es",    {currency:"MXN"}) -> "249,90 MXN"
   *     Intl.NumberFormat("es-MX", {currency:"MXN"}) -> "$249.90"
   *
   * O `es` puro cai na convenção da ESPANHA: vírgula decimal e o código ISO
   * depois do número. Quem vende no México lê "$249.90". O idioma da interface
   * é preferência de quem LÊ; a moeda é fato do NEGÓCIO, e é ela que manda no
   * separador decimal e no símbolo.
   */
  it("formata cada moeda na convenção de quem a usa", () => {
    expect(semNbsp(formatCents(24990, "BRL"))).toBe("R$ 249,90");
    expect(semNbsp(formatCents(24990, "MXN"))).toBe("$249.90");
    expect(semNbsp(formatCents(24990, "USD"))).toBe("$249.90");
    // Kwanza: símbolo DEPOIS do número e vírgula decimal, que é a convenção de
    // Angola — `formatadorDa` maximiza `und-AO` para `pt-AO` e é o ICU que
    // decide, não uma tabela nossa.
    expect(semNbsp(formatCents(24990, "AOA"))).toBe("249,90 Kz");
    // Euro: moeda sem país. A maximização de `und-EU` daria `€249.90`, a
    // convenção irlandesa; Portugal, Espanha, França, Alemanha e Itália
    // escrevem assim.
    expect(semNbsp(formatCents(24990, "EUR"))).toBe("249,90 €");
    expect(semNbsp(formatCents(149700, "EUR"))).toBe("1497,00 €");
  });

  /**
   * Servir uma moeda são TRÊS coisas juntas (ver o bloco de `MOEDAS_SERVIDAS`):
   * o seletor oferece, o schema aceita e `formatCents` sabe escrevê-la. As duas
   * primeiras já têm guarda em `tests/unit/moeda-da-organizacao-se-escolhe-na-tela.test.ts`;
   * a terceira é esta. Sem ela, uma moeda podia entrar na lista e cair no ramo
   * de degradação (`"AOA 249.90"`) sem nada ficar vermelho.
   */
  it("toda moeda servida sai formatada, nenhuma cai no ramo de degradação", () => {
    for (const moeda of MOEDAS_SERVIDAS) {
      expect(semNbsp(formatCents(24990, moeda))).not.toBe(`${moeda} 249.90`);
    }
  });

  /**
   * ⚠️ `_cents` não é sempre "centésimos", e o CHECK do banco não impede isso.
   *
   * `catalog_products.moeda` aceita qualquer `^[A-Z]{3}$`, mas todo o código de
   * dinheiro divide por 100 em duro. JPY e CLP não têm subunidade: 25.000
   * unidades menores são ￥25.000, e o /100 fixo mostra ￥250 — cem vezes menos,
   * no número que o agente de IA cota ao cliente.
   *
   * A permissão do schema é mais larga que a aritmética do código. Derivar as
   * unidades menores do próprio `Intl` fecha a diferença sem tabela na mão.
   */
  it("respeita as unidades menores da moeda, que nem sempre são 2", () => {
    expect(semNbsp(formatCents(25000, "JPY"))).toBe("￥25,000");
    expect(semNbsp(formatCents(25000, "CLP"))).toBe("$25.000");
    expect(semNbsp(formatCents(25000, "BRL"))).toBe("R$ 250,00");
  });


  /**
   * ⚠️ `formatCents` é EXPORTADA e roda num client component
   * (`app/app/products/_client.tsx`) — um valor de moeda ruim não pode
   * derrubar o render da lista inteira de produtos. Medido antes de escrever
   * o guard: `new Intl.NumberFormat(locale, {style:"currency", currency})`
   * LANÇA para `""`, `"BR"` (2 letras), `undefined` e `null`, mesmo que o
   * CHECK do banco (`^[A-Z]{3}$`) garanta o formato em toda linha que passa
   * por ele — a função não pode presumir que todo chamador futuro respeita
   * essa garantia. As cinco cópias que esta função substitui tinham
   * `try/catch` (ex.: `CRMSidePanel.tsx:201`); esta precisa da mesma rede.
   */
  it("não lança para moeda ruim — mostra o número em vez de derrubar a tela", () => {
    expect(() => formatCents(24990, "")).not.toThrow();
    expect(() => formatCents(24990, "BR")).not.toThrow();
    expect(() => formatCents(24990, undefined as unknown as string)).not.toThrow();
    expect(() => formatCents(24990, null as unknown as string)).not.toThrow();

    // O fallback precisa continuar informativo — o número certo, não "—" nem "".
    expect(formatCents(24990, "")).toContain("249");
  });
});
describe("MOEDAS_SERVIDAS — a lista que a tela oferece", () => {
  /**
   * ⚠️ ESTE CASO EXISTE PORQUE O ITEM NÃO TINHA GATE NENHUM.
   * Acrescentar `AOA` à lista é aditivo e não quebra teste algum: medido
   * tirando a moeda de volta — `lib/money.test.ts` seguia 11/11 e o
   * `tsc` saía zerado. Ou seja, nada prendia a oferta na tela, e quem
   * instalou em Angola voltaria a não ter como escolher a própria moeda
   * sem ninguém ficar sabendo.
   *
   * O que este caso prende é a OFERTA, não o padrão: o padrão continua
   * sendo o real, e isso é o caso seguinte.
   */
  it("serve o kwanza, e continua servindo as três de antes", () => {
    expect(MOEDAS_SERVIDAS).toContain("AOA");
    expect(MOEDAS_SERVIDAS).toContain("BRL");
    expect(MOEDAS_SERVIDAS).toContain("MXN");
    expect(MOEDAS_SERVIDAS).toContain("USD");
  });

  it("serve o euro, com o símbolo que o seletor mostra", () => {
    expect(MOEDAS_SERVIDAS).toContain("EUR");
    expect(simboloDaMoeda("EUR")).toBe("€");
  });

  it("e o padrão de quem não escolheu segue sendo o real", () => {
    expect(MOEDA_PADRAO).toBe("BRL");
  });
});

describe("formatValorDoNegocio — a régua do negócio é ×100 em qualquer moeda", () => {
  const semNbsp = (t: string) => t.replace(/[\u00a0\u202f]/g, " ");

  it("⭐ guarani: 12.500.000 no negócio é ₲125.000, não cem vezes mais", () => {
    expect(semNbsp(formatValorDoNegocio(12_500_000, "PYG"))).toBe("Gs. 125.000");
    expect(semNbsp(formatValorDoNegocio(25_000_000, "PYG"))).toBe("Gs. 250.000");
  });

  it("em moeda de duas casas coincide com formatCents", () => {
    expect(semNbsp(formatValorDoNegocio(24990, "BRL"))).toBe(semNbsp(formatCents(24990, "BRL")));
  });

  it("sem centavos é o formato do card: real continua como sempre foi", () => {
    expect(semNbsp(formatValorDoNegocio(125_000, "BRL", { semCentavos: true }))).toBe("R$ 1.250");
    expect(semNbsp(formatValorDoNegocio(12_500_000, "PYG", { semCentavos: true }))).toBe("Gs. 125.000");
  });
});
