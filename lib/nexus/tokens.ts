/**
 * Tokens centrais da camada Nexus UI.
 *
 * Fonte de verdade visual continua em `app/globals.css` (CSS vars). Este
 * módulo é o espelho tipado para o JS/TS: alturas, densidades, durações e
 * raios que precisam aparecer em lógica (tabelas virtuais, drawers, testes).
 * Nunca definir valor arbitrário página por página — importar daqui.
 */

export const nexusTokens = {
  buttonHeight: { sm: 32, default: 36, lg: 44 },
  inputHeight: { sm: 32, default: 36, lg: 44 },
  tableRowHeight: 56,
  tableGap: 24,
  tablePaddingX: 20,
  tablePaddingY: 16,
  radius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
  touchTargetMin: 44,
  duration: { fast: 120, base: 200, slow: 320 },
  easing: {
    out: "cubic-bezier(0.2, 0, 0, 1)",
    inOut: "cubic-bezier(0.25, 0.1, 0.25, 1)",
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  },
  zIndex: { base: 0, raised: 10, dropdown: 20, sticky: 30, modal: 40, toast: 50 },
} as const;

export type NexusTokens = typeof nexusTokens;

/** Classes canônicas de container de tabela/lista (mobile: vira cards via `renderCard`). */
export const nexusTableContainerClass =
  "overflow-x-auto rounded-lg border border-border bg-surface";

/** Altura mínima de alvo de toque (mobile): aplicada via `min-h-[44px] lg:min-h-0`. */
export const nexusTouchTargetClass = "min-h-[44px] lg:min-h-0";
