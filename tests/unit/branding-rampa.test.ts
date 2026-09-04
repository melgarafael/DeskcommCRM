import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CURVA_C,
  ESCADA_L,
  GRAUS,
  K,
  deltaEOklab,
  ehHexValido,
  hexParaOklab,
  hexParaOklch,
  hexParaRgb,
  linearParaHex,
  normalizarHex,
  oklabParaLinear,
  oklchParaHex,
  rampaDeSemente,
  rgbParaHex,
} from "@/lib/branding/rampa";

const RAIZ = process.cwd();
const CSS = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");

/**
 * Os stops esperados saem do CSS, NÃO de uma cópia colada aqui.
 *
 * Copiar à mão criaria uma segunda fonte da verdade que envelhece em silêncio: quem
 * mexesse na paleta do design system veria este teste verde contra a paleta de ontem, e
 * a catraca deixaria de calibrar contra a régua. Lendo do arquivo, mudar a Sage quebra
 * este teste — que é exatamente o aviso que se quer.
 */
/**
 * O bloco `:root` sai por casamento de chaves, e não por `slice` entre duas
 * `indexOf`. A versão anterior cortava de `indexOf(":root")` até
 * `indexOf('[data-theme="dark"]')` e quebrou na migração para o Tailwind 4: o
 * `@custom-variant dark (&:where([data-theme="dark"], …))` pôs essa string no
 * TOPO do arquivo, antes do `:root`, e a fatia virou vazia. O sintoma foi
 * "não achei --color-accent-50 no :root", que aponta para o lugar errado —
 * o `:root` estava intacto; quem tinha se mexido era o delimitador.
 */
function blocoRoot(css: string): string {
  const i = css.search(/^:root\s*\{/m);
  if (i < 0) throw new Error("não achei o bloco `:root` em globals.css");
  const fim = css.indexOf("\n}", i);
  if (fim < 0) throw new Error("bloco `:root` sem fechamento em globals.css");
  return css.slice(i, fim);
}

function stopsSageDoCss(): string[] {
  const raiz = blocoRoot(CSS);
  return GRAUS.map((g) => {
    const m = new RegExp(`--color-accent-${g}:\\s*(#[0-9a-f]{6})`, "i").exec(raiz);
    if (!m?.[1]) throw new Error(`não achei --color-accent-${g} no :root do globals.css`);
    return m[1].toLowerCase();
  });
}

const distanciaPorCanal = (a: string, b: string): number => {
  const x = hexParaRgb(a);
  const y = hexParaRgb(b);
  return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b));
};

describe("conversões de cor", () => {
  it("faz ida-e-volta hex → OKLab → hex sem perder mais que 1/255", () => {
    for (const hex of ["#506d48", "#f5c518", "#0f172a", "#ffffff", "#000000", "#7c3aed"]) {
      const volta = linearParaHex(oklabParaLinear(hexParaOklab(hex)));
      expect(distanciaPorCanal(hex, volta), `${hex} → ${volta}`).toBeLessThanOrEqual(1);
    }
  });

  it("aceita as quatro formas de hex e recusa o resto", () => {
    expect(normalizarHex("#ABC")).toBe("#aabbcc");
    expect(normalizarHex("506d48")).toBe("#506d48");
    expect(ehHexValido("#12345")).toBe(false);
    // Lançar é deliberado: engolir lixo devolveria preto silencioso e a marca do cliente
    // sumiria sem ninguém saber por quê.
    expect(() => hexParaRgb("azul")).toThrow(TypeError);
  });

  it("clampa para o sRGB reduzindo croma, e não clipando canal", () => {
    // Roxo muito além do gamut. Clipar canal (`min(1, max(0, v))` em cada um) desloca o
    // MATIZ, porque o canal que estoura é só um; reduzir croma mantém L e h.
    const pedido = { L: 0.55, C: 0.42, h: 300 };
    const porCroma = oklchParaHex(pedido);
    const porClipe = linearParaHex(
      oklabParaLinear({
        L: pedido.L,
        a: pedido.C * Math.cos((pedido.h * Math.PI) / 180),
        b: pedido.C * Math.sin((pedido.h * Math.PI) / 180),
      }),
    );

    const desvio = (hex: string) => Math.abs(hexParaOklch(hex).h - pedido.h);
    expect(desvio(porCroma)).toBeLessThan(1);
    // Controle positivo do próprio teste: se o clipe NÃO deslocasse o matiz, a
    // comparação acima não provaria nada. Ele desloca — medido ~13° neste pedido.
    expect(desvio(porClipe)).toBeGreaterThan(5);
    expect(desvio(porCroma)).toBeLessThan(desvio(porClipe));
  });
});

describe("rampaDeSemente — catraca de calibração contra o design system", () => {
  const esperados = stopsSageDoCss();

  it("lê 11 stops distintos do globals.css (guarda de vacuidade)", () => {
    // Sem isto, um regex quebrado devolveria lista vazia e a comparação abaixo passaria
    // por não ter o que comparar — instrumento morto tem cara de teste verde.
    expect(esperados).toHaveLength(11);
    expect(new Set(esperados).size).toBe(11);
    expect(esperados[K]).toBe("#506d48");
  });

  it("reproduz os 11 stops Sage a partir de #506d48 com Δ ≤ 2/255 por canal", () => {
    const derivada = rampaDeSemente("#506d48");
    const distancias = esperados.map((esperado, i) => distanciaPorCanal(esperado, derivada[i]!));
    expect(
      Math.max(...distancias),
      `derivada: ${derivada.join(" ")}\nesperada: ${esperados.join(" ")}\nΔ: ${distancias.join(",")}`,
    ).toBeLessThanOrEqual(2);
  });

  it("devolve o hex LITERAL no stop da semente", () => {
    // Ida-e-volta por OKLab erra ±1/255. Mostrar `#516d49` no seletor de cor enquanto a
    // UI pinta `#506d48` custa mais confiança do que o pixel vale.
    for (const semente of ["#506d48", "#f5c518", "#0f172a", "#e11d48"]) {
      expect(rampaDeSemente(semente)[K]).toBe(semente);
    }
  });
});

describe("ancoragem por PAPEL, não por lightness", () => {
  it("mantém a navy #0f172a no stop 600, onde a lightness a jogaria no 950", () => {
    const semente = "#0f172a";
    const { L } = hexParaOklch(semente);

    // A âncora por lightness escolheria o índice cuja L é a mais próxima da semente.
    const porLightness = ESCADA_L.reduce(
      (melhor, l, i) => (Math.abs(l - L) < Math.abs(ESCADA_L[melhor]! - L) ? i : melhor),
      0,
    );
    expect(porLightness, "a semente precisa estar longe de K para o teste valer").not.toBe(K);
    expect(porLightness).toBe(10);

    // O que a doutrina exige: o hex do cliente É o accent do tema claro.
    const rampa = rampaDeSemente(semente);
    expect(rampa[K]).toBe(semente);
    expect(hexParaOklch(rampa[K]!).L).toBeCloseTo(L, 6);

    // E a cor que a ancoragem por lightness produziria no papel de accent é OUTRA cor —
    // é o `#4360a7` periwinkle do relato. Aqui só se prova que ela seria longe: ΔE alto
    // contra a marca. Sem esta linha, "ancorou por papel" seria afirmação sem contraste.
    const accentSeAncorasseNaLightness = oklchParaHex({
      L: ESCADA_L[K]!,
      C: (hexParaOklch(semente).C / CURVA_C[porLightness]!) * CURVA_C[K]!,
      h: hexParaOklch(semente).h,
    });
    expect(deltaEOklab(accentSeAncorasseNaLightness, semente)).toBeGreaterThan(0.25);
  });

  it("atravessa a lightness da semente no índice K para qualquer semente", () => {
    for (const semente of ["#f5c518", "#0f172a", "#2563eb", "#22c55e", "#4b0082"]) {
      const { L } = hexParaOklch(semente);
      expect(hexParaOklch(rampaDeSemente(semente)[K]!).L).toBeCloseTo(L, 6);
    }
  });

  it("preserva o matiz da marca em todos os stops que cabem no sRGB", () => {
    // Um stop que muda de matiz é a marca virando outra marca no hover.
    for (const semente of ["#2563eb", "#e11d48", "#14b8a6"]) {
      const h = hexParaOklch(semente).h;
      const rampa = rampaDeSemente(semente);
      // As pontas (50 e 950) têm croma tão baixo que o ângulo fica numericamente
      // instável — ali o desvio de matiz não é visível. Medimos o miolo.
      for (let i = 2; i <= 8; i += 1) {
        const desvio = Math.abs(((hexParaOklch(rampa[i]!).h - h + 540) % 360) - 180);
        expect(desvio, `${semente} stop ${GRAUS[i]}`).toBeLessThan(2);
      }
    }
  });
});

describe("forma da escada", () => {
  it("mantém as constantes na forma que a derivação assume", () => {
    // Sabotar qualquer uma destas quebra a calibração acima; estas asserções existem
    // para dizer QUAL invariante quebrou, e não só que "a Sage não bate mais".
    expect(ESCADA_L).toHaveLength(11);
    expect(CURVA_C).toHaveLength(11);
    expect(CURVA_C[K]).toBe(1);
    expect(K).toBe(6);
    expect(GRAUS[K]).toBe(600);
    // A escada desce do 50 ao 950, sem platô — platô significa dois graus com o mesmo
    // papel visual, e a rampa perde um degrau útil.
    for (let i = 1; i < ESCADA_L.length; i += 1) {
      expect(ESCADA_L[i]!, `stop ${GRAUS[i]}`).toBeLessThan(ESCADA_L[i - 1]!);
    }
  });

  it("emite hex normalizado em todos os stops", () => {
    for (const stop of rampaDeSemente("#7c3aed")) {
      expect(stop).toMatch(/^#[0-9a-f]{6}$/);
      expect(rgbParaHex(hexParaRgb(stop))).toBe(stop);
    }
  });
});
