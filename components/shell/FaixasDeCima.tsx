"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** A altura das faixas de cima, publicada no `<html>` para quem precisa descontá-la. */
export const VARIAVEL_DAS_FAIXAS = "--faixas-de-cima";

/**
 * AS FAIXAS DO TOPO (canal caído, impersonação, cobrança) E A ALTURA DELAS.
 *
 * Elas ficam acima da casca e não cabem numa constante: o aviso de canal caído
 * tem `flex-wrap` e a frase do papel `agent` quebra em uma, duas ou três
 * linhas. Sem descontá-las, o documento media a tela MAIS a faixa — o composer
 * do Inbox nascia abaixo da borda no celular justamente quando o WhatsApp
 * estava desconectado.
 *
 * Quem lê `--faixas-de-cima`: a casca (`AppShell`), o `TopBar` e a `Sidebar`
 * (que grudam abaixo delas em vez de passar por baixo), a grade do Inbox e a
 * conversa em tela cheia do celular (`colunasDoCelular`).
 *
 * O invólucro é `sticky top-0` porque um sticky só gruda dentro da caixa do
 * pai: as faixas sozinhas, dentro deste `<div>` da altura delas, passariam a
 * rolar junto com a página. E ele empilha as faixas — antes, duas sticky em
 * `top-0` se sobrepunham quando apareciam juntas.
 */
export function FaixasDeCima({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const elemento = ref.current;
    if (!elemento) return;
    const raiz = document.documentElement;
    const publicar = () =>
      raiz.style.setProperty(
        VARIAVEL_DAS_FAIXAS,
        `${Math.ceil(elemento.getBoundingClientRect().height)}px`,
      );
    publicar();
    const observador = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publicar);
    observador?.observe(elemento);
    return () => {
      observador?.disconnect();
      raiz.style.removeProperty(VARIAVEL_DAS_FAIXAS);
    };
  }, []);

  return (
    <div ref={ref} className="sticky top-0 z-50">
      {children}
    </div>
  );
}
