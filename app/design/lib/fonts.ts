import localFont from "next/font/local";

// Note: next/font requires module-level constants; we expose all 4 pair vars
// at once. CSS swaps via --font-display / --font-body / --font-mono picker.
//
// Arquivos em app/fonts/ (origem e licença no README de lá), para o build não
// depender do Google. A família se chama como a variável JS ("bricolage"):
// referencie sempre a custom property. "Times New Roman" nas serifadas é o
// fallback que o next/font/google escolhia para elas.

export const bricolage = localFont({
  src: "../../fonts/bricolage-grotesque-200-800-latin.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-bricolage",
});

export const jakarta = localFont({
  src: "../../fonts/plus-jakarta-sans-200-800-latin.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-jakarta",
});

// Eixos opsz, SOFT e WONK vêm no próprio arquivo variável.
export const fraunces = localFont({
  src: "../../fonts/fraunces-100-900-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-fraunces",
  adjustFontFallback: "Times New Roman",
});

export const manrope = localFont({
  src: "../../fonts/manrope-200-800-latin.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-manrope",
});

export const atkinson = localFont({
  src: [
    { path: "../../fonts/atkinson-hyperlegible-400-latin-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/atkinson-hyperlegible-700-latin-latin-ext.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-atkinson",
});

export const sourceSerif = localFont({
  src: "../../fonts/source-serif-4-200-900-latin.woff2",
  weight: "200 900",
  style: "normal",
  display: "swap",
  variable: "--font-source-serif",
  adjustFontFallback: "Times New Roman",
});

// Um arquivo variável declarado nos 5 pesos pedidos, como o Google servia.
// (O next/font só aceita literal aqui — por isso o caminho repetido.)
export const plexSans = localFont({
  src: [
    { path: "../../fonts/ibm-plex-sans-300-700-latin.woff2", weight: "300", style: "normal" },
    { path: "../../fonts/ibm-plex-sans-300-700-latin.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/ibm-plex-sans-300-700-latin.woff2", weight: "500", style: "normal" },
    { path: "../../fonts/ibm-plex-sans-300-700-latin.woff2", weight: "600", style: "normal" },
    { path: "../../fonts/ibm-plex-sans-300-700-latin.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-plex-sans",
});

export const plexMono = localFont({
  src: [
    { path: "../../fonts/ibm-plex-mono-400-latin-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/ibm-plex-mono-500-latin-latin-ext.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-plex-mono",
});

export const jetbrains = localFont({
  src: "../../fonts/jetbrains-mono-100-800-latin.woff2",
  weight: "100 800",
  style: "normal",
  display: "swap",
  variable: "--font-jetbrains",
});

export const allFontVariables = [
  bricolage.variable,
  jakarta.variable,
  fraunces.variable,
  manrope.variable,
  atkinson.variable,
  sourceSerif.variable,
  plexSans.variable,
  plexMono.variable,
  jetbrains.variable,
].join(" ");
