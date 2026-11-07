"use client";

import { useSyncExternalStore } from "react";

import {
  conversasComMencao,
  inscreverNaListaDeMencoes,
} from "@/lib/notifications/mencao-na-lista";

/**
 * As conversas que têm menção pendente para esta pessoa (#2372).
 *
 * Quem marca é o listener de notas (`useCrmAlerts`); aqui só se LÊ. O snapshot é
 * o mesmo objeto até a marca mudar (`lib/notifications/mencao-na-lista.ts`), que
 * é o que o `useSyncExternalStore` exige para não re-renderizar a lista inteira
 * a cada tecla. O terceiro argumento repete a leitura no servidor/SSR: sem
 * listener, a marca é sempre vazia — e é o certo, porque ela nasce de um evento
 * do navegador.
 */
export function useConversasComMencao(): ReadonlySet<string> {
  return useSyncExternalStore(
    inscreverNaListaDeMencoes,
    conversasComMencao,
    conversasComMencao,
  );
}
