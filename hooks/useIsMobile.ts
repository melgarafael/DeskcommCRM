"use client";

import * as React from "react";

/**
 * Breakpoint mobile do CRM: <768px (abaixo do `md` do Tailwind — ver
 * docs/design-system/screen-flow/07-responsive-strategy.md).
 *
 * Só use este hook onde o COMPORTAMENTO muda (desligar drag-drop, decidir
 * qual coluna do Inbox renderizar) — onde é só aparência, prefira classes
 * Tailwind puras (`md:hidden`) em vez de JS: mais barato e sem risco de
 * flash entre o valor default do server e o valor real do client.
 *
 * Mesmo cuidado de SSR do `lib/theme.tsx`: o server não conhece o viewport,
 * então o default é `false` até o primeiro efeito rodar no client.
 */
const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    setIsMobile(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
