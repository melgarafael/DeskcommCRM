"use client";

import * as React from "react";

/**
 * Autosave do rascunho (§31): salva no localStorage com debounce, nunca a
 * cada tecla. Restaura ao voltar (navegador fechado no meio da venda não
 * perde nada). O servidor só vê o pedido no Salvar/Finalizar — rascunho
 * local não é rascunho no banco.
 */
export interface RascunhoSalvo {
  salvoEm: number;
  dados: Record<string, unknown>;
}

export function useAutosaveDraft(chave: string, dados: Record<string, unknown>, ativo: boolean) {
  const [salvoEm, setSalvoEm] = React.useState<number | null>(null);
  const [restaurou, setRestaurou] = React.useState(false);
  const ref = React.useRef(dados);
  React.useEffect(() => {
    ref.current = dados;
  });

  const carregar = React.useCallback((): Record<string, unknown> | null => {
    try {
      const cru = window.localStorage.getItem(chave);
      if (!cru) return null;
      const parsed = JSON.parse(cru) as RascunhoSalvo;
      setSalvoEm(parsed.salvoEm);
      setRestaurou(true);
      return parsed.dados;
    } catch {
      return null;
    }
  }, [chave]);

  const assinatura = JSON.stringify(dados);
  React.useEffect(() => {
    if (!ativo) return;
    const timer = setTimeout(() => {
      try {
        const agora = Date.now();
        window.localStorage.setItem(chave, JSON.stringify({ salvoEm: agora, dados: ref.current }));
        setSalvoEm(agora);
      } catch {
        // Quota cheia ou privado: autosave é cortesia, nunca erro.
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [chave, ativo, assinatura]);

  const limpar = React.useCallback(() => {
    try {
      window.localStorage.removeItem(chave);
    } catch {
      // Silêncio de propósito (ver acima).
    }
    setSalvoEm(null);
    setRestaurou(false);
  }, [chave]);

  return { salvoEm, restaurou, carregar, limpar };
}

/** "há N segundos/minutos" para o selo de salvo. */
export function haQuantoTempo(salvoEm: number | null): string | null {
  if (!salvoEm) return null;
  const s = Math.max(0, Math.round((Date.now() - salvoEm) / 1000));
  if (s < 5) return "agora mesmo";
  if (s < 60) return `há ${s} segundos`;
  return `há ${Math.floor(s / 60)} min`;
}
