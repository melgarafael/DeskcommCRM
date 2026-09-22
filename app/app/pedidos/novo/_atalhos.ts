"use client";

import * as React from "react";

/**
 * Atalhos do editor (§46, sem conflitar com a paleta global).
 *
 * A paleta ⌘K/Ctrl+K do app é GLOBAL — o editor não a rouba. Aqui:
 * - `/` foca a busca de produto (fora de input);
 * - `Ctrl+Enter` finaliza (salva como aprovado);
 * - `Esc` tira o foco / fecha a busca.
 */
export function useOrderShortcuts(opcoes: {
  focarBusca: () => void;
  finalizar: () => void;
  desfocar: () => void;
}): void {
  const ref = React.useRef(opcoes);
  React.useEffect(() => {
    ref.current = opcoes;
  });

  React.useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      const alvo = e.target as HTMLElement | null;
      const emCampo = alvo && (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA" || alvo.tagName === "SELECT");
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ref.current.finalizar();
        return;
      }
      if (e.key === "Escape") {
        ref.current.desfocar();
        return;
      }
      if (e.key === "/" && !emCampo) {
        e.preventDefault();
        ref.current.focarBusca();
      }
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, []);
}
