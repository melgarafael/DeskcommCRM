"use client";

import { useSyncExternalStore } from "react";

/**
 * O pedido de instalação que o Chromium oferece (`beforeinstallprompt`).
 *
 * Capturado no nível do MÓDULO, e o módulo é carregado pela raiz do app
 * (`app/providers.tsx`): o navegador dispara o evento uma vez, em geral já no
 * `/login`, e o login termina numa navegação sem recarregar a página — um
 * ouvinte montado só na tela de instalar nunca o veria.
 *
 * Sem `preventDefault`: a sugestão do próprio navegador continua aparecendo.
 */
interface PedidoDoNavegador extends Event {
  prompt(): Promise<unknown>;
}

let pedido: PedidoDoNavegador | null = null;
const ouvintes = new Set<() => void>();
const avisar = () => ouvintes.forEach((ouvinte) => ouvinte());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (evento) => {
    pedido = evento as PedidoDoNavegador;
    avisar();
  });
  window.addEventListener("appinstalled", () => {
    pedido = null;
    avisar();
  });
}

function assinar(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

/** Há pedido de instalação na mão? No servidor, nunca. */
export function usePedidoDeInstalacao(): boolean {
  return useSyncExternalStore(
    assinar,
    () => pedido !== null,
    () => false,
  );
}

/** Abre o diálogo do navegador. O pedido só serve uma vez. */
export async function pedirInstalacao(): Promise<void> {
  const atual = pedido;
  pedido = null;
  avisar();
  if (atual) await atual.prompt();
}
