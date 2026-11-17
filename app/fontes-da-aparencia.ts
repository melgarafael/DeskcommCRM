import localFont from "next/font/local";

/**
 * As famílias que a tela Aparência oferece (`lib/aparencia/fontes.ts`), vindas
 * dos arquivos JÁ versionados em `app/fonts/` — nada é baixado no build.
 *
 * `preload: false` em todas: declarar a família só cria o `@font-face`, e o
 * navegador baixa o arquivo apenas quando alguma regra ativa a usa (uma
 * organização com template ou com fonte escolhida). Quem não mexe na aparência
 * não baixa um byte a mais.
 *
 * A Atkinson e a Plex Mono continuam em `app/layout.tsx`, de onde vêm desde
 * sempre — são as fontes de fábrica do produto.
 */

export const fonteManrope = localFont({
  src: "./fonts/manrope-200-800-latin.woff2",
  weight: "200 800",
  display: "swap",
  preload: false,
  variable: "--fonte-manrope",
});

export const fonteJakarta = localFont({
  src: "./fonts/plus-jakarta-sans-200-800-latin.woff2",
  weight: "200 800",
  display: "swap",
  preload: false,
  variable: "--fonte-jakarta",
});

export const fontePlex = localFont({
  src: "./fonts/ibm-plex-sans-300-700-latin.woff2",
  weight: "300 700",
  display: "swap",
  preload: false,
  variable: "--fonte-plex",
});

export const fonteBricolage = localFont({
  src: "./fonts/bricolage-grotesque-200-800-latin.woff2",
  weight: "200 800",
  display: "swap",
  preload: false,
  variable: "--fonte-bricolage",
});

export const fonteSourceSerif = localFont({
  src: "./fonts/source-serif-4-200-900-latin.woff2",
  weight: "200 900",
  display: "swap",
  preload: false,
  variable: "--fonte-source-serif",
  adjustFontFallback: "Times New Roman",
});

export const fonteFraunces = localFont({
  src: "./fonts/fraunces-100-900-latin.woff2",
  weight: "100 900",
  display: "swap",
  preload: false,
  variable: "--fonte-fraunces",
  adjustFontFallback: "Times New Roman",
});

export const fonteJetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-100-800-latin.woff2",
  weight: "100 800",
  display: "swap",
  preload: false,
  variable: "--fonte-jetbrains-mono",
});

/** As classes que declaram as sete custom properties no `<html>`. */
export const VARIAVEIS_DAS_FONTES_DA_APARENCIA = [
  fonteManrope,
  fonteJakarta,
  fontePlex,
  fonteBricolage,
  fonteSourceSerif,
  fonteFraunces,
  fonteJetbrainsMono,
]
  .map((f) => f.variable)
  .join(" ");
