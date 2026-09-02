// Design tokens for SonghaiCRM showcase.
// "Soft-tech / calmo" — neutros desaturados (greige/warm-gray), accent não-saturado.
// 5-Constraint Rule applied: Shape, Color (exact hex), Typography, Motion, Layout.

export type PaletteId = "sage" | "clay" | "mist" | "plum" | "olive";
export type TypoId = "bricolage-jakarta" | "fraunces-manrope" | "atkinson" | "source-plex";
export type DensityId = "aerada" | "equilibrada" | "compacta";
export type ThemeId = "light" | "dark";

export type ColorScale = {
  50: string; 100: string; 200: string; 300: string; 400: string;
  500: string; 600: string; 700: string; 800: string; 900: string; 950: string;
};

export type StateColors = {
  success: string;
  warning: string;
  error: string;
  info: string;
};

export type PaletteDef = {
  id: PaletteId;
  name: string;
  description: string;
  accent: ColorScale;
  // Greige/warm-gray neutrals — explicitly NOT slate/zinc.
  neutralLight: ColorScale;
  neutralDark: ColorScale;
  states: { light: StateColors; dark: StateColors };
  // Page-level surfaces tuned per palette (light + dark).
  surfaces: {
    light: { bg: string; surface: string; surfaceElevated: string; text: string; textMuted: string; border: string };
    dark: { bg: string; surface: string; surfaceElevated: string; text: string; textMuted: string; border: string };
  };
};

// ─── Palettes ──────────────────────────────────────────────────────────────

export const PALETTES: Record<PaletteId, PaletteDef> = {
  sage: {
    id: "sage",
    name: "Sage",
    description: "Verde WhatsApp. Reconhecível, vivo, o verde do canal primário.",
    accent: {
      50: "#eef8f4", 100: "#d9efe8", 200: "#b3dfd1", 300: "#80c7b3",
      400: "#49b198", 500: "#169b80", 600: "#008069", 700: "#136553",
      800: "#175244", 900: "#194439", 950: "#08221b",
    },
    neutralLight: {
      50: "#faf9f6", 100: "#f3f1ec", 200: "#e7e3da", 300: "#d2cdbf",
      400: "#a9a395", 500: "#7d786c", 600: "#5d594f", 700: "#46433b",
      800: "#2e2c26", 900: "#1c1a16", 950: "#0e0d0a",
    },
    neutralDark: {
      50: "#f5f4ef", 100: "#e6e4dc", 200: "#bbb8ac", 300: "#8e8b7f",
      400: "#605e54", 500: "#444239", 600: "#33312a", 700: "#272620",
      800: "#1d1c17", 900: "#161510", 950: "#0c0b08",
    },
    states: {
      light: { success: "#5a8a5f", warning: "#b07a2b", error: "#a94a3c", info: "#4a7a93" },
      dark:  { success: "#82a077", warning: "#d09455", error: "#c87263", info: "#7da9bf" },
    },
    surfaces: {
      light: { bg: "#faf9f6", surface: "#ffffff", surfaceElevated: "#f5f3ee", text: "#1c1a16", textMuted: "#5d594f", border: "#e7e3da" },
      dark:  { bg: "#161510", surface: "#1d1c17", surfaceElevated: "#272620", text: "#f5f4ef", textMuted: "#8e8b7f", border: "#33312a" },
    },
  },
  clay: {
    id: "clay",
    name: "Clay",
    description: "Terracota quente. Acolhedor, artesanal, terroso.",
    accent: {
      50: "#fbf3ef", 100: "#f4e0d3", 200: "#e7bda5", 300: "#d79376",
      400: "#c47353", 500: "#b05a3d", 600: "#934531", 700: "#76382a",
      800: "#5e2f25", 900: "#4d2820", 950: "#28130f",
    },
    neutralLight: {
      50: "#fbf8f4", 100: "#f3eee5", 200: "#e6dccb", 300: "#cebfa6",
      400: "#a5957c", 500: "#7a6c57", 600: "#5b5043", 700: "#453d33",
      800: "#2d2823", 900: "#1c1814", 950: "#0e0c0a",
    },
    neutralDark: {
      50: "#f6f1ea", 100: "#e6dccb", 200: "#b8aa94", 300: "#8a7e6b",
      400: "#5d5447", 500: "#403930", 600: "#302b25", 700: "#24211c",
      800: "#1b1815", 900: "#13110f", 950: "#0a0908",
    },
    states: {
      light: { success: "#5e8b62", warning: "#9c6321", error: "#a94431", info: "#506e8a" },
      dark:  { success: "#85a98a", warning: "#cf8d4a", error: "#c8765d", info: "#7e9fbb" },
    },
    surfaces: {
      light: { bg: "#fbf8f4", surface: "#ffffff", surfaceElevated: "#f5f0e6", text: "#1c1814", textMuted: "#5b5043", border: "#e6dccb" },
      dark:  { bg: "#13110f", surface: "#1b1815", surfaceElevated: "#24211c", text: "#f6f1ea", textMuted: "#8a7e6b", border: "#302b25" },
    },
  },
  mist: {
    id: "mist",
    name: "Mist",
    description: "Azul-poeira frio. Discreto, focado, marítimo.",
    accent: {
      50: "#f1f4f7", 100: "#dde5ec", 200: "#b8c8d6", 300: "#8da7bd",
      400: "#6789a3", 500: "#4f6f88", 600: "#3f586d", 700: "#344758",
      800: "#2a3a48", 900: "#22303b", 950: "#11181d",
    },
    neutralLight: {
      50: "#f8f8f6", 100: "#eeede9", 200: "#dddbd3", 300: "#bcb9ad",
      400: "#8d8a7e", 500: "#65635a", 600: "#4b4943", 700: "#37362f",
      800: "#26251f", 900: "#181712", 950: "#0c0b08",
    },
    neutralDark: {
      50: "#f1f1ee", 100: "#d9d8d2", 200: "#a9a8a0", 300: "#7d7c75",
      400: "#56554f", 500: "#3a3935", 600: "#2c2b27", 700: "#21201d",
      800: "#181712", 900: "#11100d", 950: "#080807",
    },
    states: {
      light: { success: "#54845d", warning: "#a47428", error: "#a14739", info: "#3f5f7a" },
      dark:  { success: "#7ea286", warning: "#cd954b", error: "#c47866", info: "#7099b6" },
    },
    surfaces: {
      light: { bg: "#f8f8f6", surface: "#ffffff", surfaceElevated: "#f1f1ed", text: "#181712", textMuted: "#4b4943", border: "#dddbd3" },
      dark:  { bg: "#11100d", surface: "#181712", surfaceElevated: "#21201d", text: "#f1f1ee", textMuted: "#7d7c75", border: "#2c2b27" },
    },
  },
  plum: {
    id: "plum",
    name: "Plum",
    description: "Ameixa suave. Sofisticado, noturno, contido.",
    accent: {
      50: "#f6f1f4", 100: "#ebdce5", 200: "#d4b2c4", 300: "#b885a0",
      400: "#9e637f", 500: "#854b66", 600: "#6c3d54", 700: "#583244",
      800: "#462937", 900: "#3a232e", 950: "#1d1118",
    },
    neutralLight: {
      50: "#faf8f8", 100: "#f1eeee", 200: "#e2dddd", 300: "#c2b9b9",
      400: "#928787", 500: "#695f5f", 600: "#4f4747", 700: "#3a3434",
      800: "#272222", 900: "#181414", 950: "#0c0a0a",
    },
    neutralDark: {
      50: "#f3f0f0", 100: "#dcd6d6", 200: "#aea5a5", 300: "#827a7a",
      400: "#5a5454", 500: "#3e3939", 600: "#2e2a2a", 700: "#221f1f",
      800: "#191616", 900: "#111010", 950: "#080707",
    },
    states: {
      light: { success: "#598661", warning: "#a47128", error: "#a4453a", info: "#4d6986" },
      dark:  { success: "#83a589", warning: "#cf914c", error: "#c77565", info: "#7c9eba" },
    },
    surfaces: {
      light: { bg: "#faf8f8", surface: "#ffffff", surfaceElevated: "#f3eeee", text: "#181414", textMuted: "#4f4747", border: "#e2dddd" },
      dark:  { bg: "#111010", surface: "#191616", surfaceElevated: "#221f1f", text: "#f3f0f0", textMuted: "#827a7a", border: "#2e2a2a" },
    },
  },
  olive: {
    id: "olive",
    name: "Olive",
    description: "Verde-oliva quente. Robusto, terroso, mediterrâneo.",
    accent: {
      50: "#f6f5ec", 100: "#e9e6cf", 200: "#d2cc9f", 300: "#b1a96b",
      400: "#928a4a", 500: "#776f3a", 600: "#5e572f", 700: "#4a4527",
      800: "#3b3722", 900: "#302d1d", 950: "#18170e",
    },
    neutralLight: {
      50: "#faf9f4", 100: "#f1efe4", 200: "#e3dfcc", 300: "#c5beA1",
      400: "#988f70", 500: "#6e6750", 600: "#534e3e", 700: "#3d392d",
      800: "#29261e", 900: "#191712", 950: "#0c0b08",
    },
    neutralDark: {
      50: "#f3f1ea", 100: "#dcd8c8", 200: "#aea795", 300: "#807a68",
      400: "#585345", 500: "#3c3830", 600: "#2c2a24", 700: "#21201b",
      800: "#181713", 900: "#11100d", 950: "#080807",
    },
    states: {
      light: { success: "#5d8a5b", warning: "#a87326", error: "#9f4636", info: "#4d7088" },
      dark:  { success: "#8aac82", warning: "#d29449", error: "#c47762", info: "#7ba2bb" },
    },
    surfaces: {
      light: { bg: "#faf9f4", surface: "#ffffff", surfaceElevated: "#f3f0e3", text: "#191712", textMuted: "#534e3e", border: "#e3dfcc" },
      dark:  { bg: "#11100d", surface: "#181713", surfaceElevated: "#21201b", text: "#f3f1ea", textMuted: "#807a68", border: "#2c2a24" },
    },
  },
};

// ─── Density ───────────────────────────────────────────────────────────────

export const DENSITIES: Record<DensityId, { label: string; rowH: string; gap: string; padX: string; padY: string }> = {
  aerada:      { label: "Aerada",      rowH: "56px", gap: "24px", padX: "20px", padY: "16px" },
  equilibrada: { label: "Equilibrada", rowH: "44px", gap: "16px", padX: "16px", padY: "10px" },
  compacta:    { label: "Compacta",    rowH: "32px", gap: "8px",  padX: "10px", padY: "6px"  },
};

// ─── Typography pairings ───────────────────────────────────────────────────

export const TYPOS: Record<TypoId, { name: string; display: string; body: string; mono: string; description: string; scale: number }> = {
  "bricolage-jakarta": {
    name: "Bricolage + Plus Jakarta",
    display: '"Bricolage Grotesque", system-ui, sans-serif',
    body: '"Plus Jakarta Sans", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
    description: "Display gestual com width axis. Body neutro humanista.",
    scale: 1.25,
  },
  "fraunces-manrope": {
    name: "Fraunces + Manrope",
    display: '"Fraunces", Georgia, serif',
    body: '"Manrope", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
    description: "Serif quente com SOFT/WONK + sans humanista.",
    scale: 1.333,
  },
  "atkinson": {
    name: "Atkinson Hyperlegible",
    display: '"Atkinson Hyperlegible", system-ui, sans-serif',
    body: '"Atkinson Hyperlegible", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
    description: "Acessibilidade-first. Glifos diferenciados, mesma família display+body.",
    scale: 1.2,
  },
  "source-plex": {
    name: "Source Serif 4 + IBM Plex Sans",
    display: '"Source Serif 4", Georgia, serif',
    body: '"IBM Plex Sans", system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, monospace',
    description: "Serif refinada Adobe + Plex IBM, par enterprise warm.",
    scale: 1.25,
  },
};

// ─── Foundation tokens ─────────────────────────────────────────────────────

export const SPACING = [
  { token: "0", px: "0px" },     { token: "1", px: "4px" },
  { token: "2", px: "8px" },     { token: "3", px: "12px" },
  { token: "4", px: "16px" },    { token: "5", px: "20px" },
  { token: "6", px: "24px" },    { token: "8", px: "32px" },
  { token: "10", px: "40px" },   { token: "12", px: "48px" },
  { token: "16", px: "64px" },   { token: "20", px: "80px" },
];

export const RADII = [
  { token: "none", value: "0px",   use: "Tabelas densas, áreas de dados, cabeçalhos de coluna." },
  { token: "xs",   value: "4px",   use: "Botões, inputs, badges. Padrão para controles." },
  { token: "sm",   value: "8px",   use: "Cards de lista, item de inbox, kanban card." },
  { token: "md",   value: "12px",  use: "Containers maiores, modais menores, panels." },
  { token: "lg",   value: "16px",  use: "Modais, popovers grandes, surfaces premium." },
  { token: "full", value: "9999px",use: "Avatar, pill badge, dot indicator." },
];

export const BORDERS = [
  { token: "hairline", value: "0.5px solid var(--border)", use: "Separadores internos. Apenas em densidade compacta." },
  { token: "thin",     value: "1px solid var(--border)",   use: "Default para cards, inputs, dividers." },
  { token: "focus",    value: "2px solid var(--accent-500)",use: "Focus ring (a11y). Sempre 2px." },
];

export const SHADOWS = [
  { token: "none",  value: "none",                                              use: "Default. Use whitespace + border." },
  { token: "sm",    value: "0 1px 2px 0 rgba(20,18,14,0.04)",                   use: "Hover discreto em cards interativos." },
  { token: "md",    value: "0 4px 12px -2px rgba(20,18,14,0.06), 0 2px 4px -1px rgba(20,18,14,0.04)", use: "Popover, dropdown, toast." },
  { token: "lg",    value: "0 12px 32px -6px rgba(20,18,14,0.10), 0 4px 12px -2px rgba(20,18,14,0.06)", use: "Modal, sheet." },
  { token: "inset", value: "inset 0 1px 0 0 rgba(255,255,255,0.04)",            use: "Highlight superior em superfícies dark." },
];

export const Z_INDEX = [
  { token: "base",     value: "0",   use: "Conteúdo." },
  { token: "raised",   value: "10",  use: "Sticky headers, badges flutuantes." },
  { token: "dropdown", value: "20",  use: "Select, popover, menu." },
  { token: "overlay",  value: "30",  use: "Tooltip." },
  { token: "modal",    value: "40",  use: "Dialog, sheet, drawer." },
  { token: "toast",    value: "50",  use: "Sonner, system messages." },
];

export const MOTION = {
  fast:    { duration: "120ms", easing: "cubic-bezier(0.2, 0, 0, 1)",     use: "Hover, press, micro-feedback." },
  base:    { duration: "200ms", easing: "cubic-bezier(0.25, 0.1, 0.25, 1)", use: "Default UI transitions." },
  slow:    { duration: "320ms", easing: "cubic-bezier(0.16, 1, 0.3, 1)",  use: "Modal enter, sheet, page-level." },
  spring:  { duration: "420ms", easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", use: "Playful (badge pop, drag confirm)." },
};
