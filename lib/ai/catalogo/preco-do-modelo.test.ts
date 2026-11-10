import { describe, expect, it } from "vitest";

import { formatarDolaresPorMilhao } from "./preco-do-modelo";

/** Troca o espaço sem quebra do Intl por espaço comum — o teste lê a frase. */
const plano = (s: string | null) => s?.replace(/ /g, " ") ?? null;

describe("formatarDolaresPorMilhao — centavos de dólar por milhão viram dólares", () => {
  it("10 centavos por milhão são US$ 0,10 — não '10'", () => {
    expect(plano(formatarDolaresPorMilhao(10, "pt-BR"))).toBe("US$ 0,10");
    expect(plano(formatarDolaresPorMilhao(50, "pt-BR"))).toBe("US$ 0,50");
  });

  it("modelo caro passa de um dólar sem perder a conta", () => {
    expect(plano(formatarDolaresPorMilhao(1500, "pt-BR"))).toBe("US$ 15,00");
  });

  it("segue o idioma da tela", () => {
    expect(plano(formatarDolaresPorMilhao(1500, "en"))).toBe("$15.00");
  });

  it("fração de centavo não é arredondada para zero", () => {
    expect(plano(formatarDolaresPorMilhao(1.5, "pt-BR"))).toBe("US$ 0,015");
  });

  it("zero é gratuito de verdade e continua sendo número", () => {
    expect(plano(formatarDolaresPorMilhao(0, "pt-BR"))).toBe("US$ 0,00");
  });

  it("preço desconhecido é null, nunca 'de graça'", () => {
    expect(formatarDolaresPorMilhao(null, "pt-BR")).toBeNull();
    expect(formatarDolaresPorMilhao(undefined, "pt-BR")).toBeNull();
    expect(formatarDolaresPorMilhao(Number.NaN, "pt-BR")).toBeNull();
    expect(formatarDolaresPorMilhao(-1, "pt-BR")).toBeNull();
  });
});
