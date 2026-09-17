"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import type { BoardData } from "@/lib/kanban/types";
import { motivosDoFunil } from "@/lib/leads/motivos-de-perda-do-funil";

/**
 * OS MOTIVOS DE PERDA CADASTRADOS NO FUNIL DESTE CARD.
 *
 * ─── Por que ler o cache, e não buscar de novo ─────────────────────────────
 *
 * O quadro já carrega `pipeline.settings` inteiro na chave `["board", pipelineId]`
 * (`useBoard`), e a janela de perder só existe a partir de um card que esse
 * quadro renderizou: quando ela abre, o dado já está na mão. Uma chamada nova
 * custaria rede e um estado de carregamento para o que a tela já tem — e é o
 * funil DESTE card, não o primeiro da lista, que decide a lista de motivos.
 *
 * Não há `useQuery` aqui de propósito: observar a chave seria pedir refetch de
 * um dado que quem controla é o quadro, e o quadro refaz a busca quando a fila
 * de eventos dele manda. Quem monta este hook está DENTRO da árvore do quadro,
 * então todo refetch dele re-renderiza o caminho até aqui e a lista se atualiza.
 *
 * Cache frio (card aberto fora do quadro, teste isolado) devolve `[]` — e `[]` é
 * exatamente o que faz a janela cair no padrão do produto, que era o
 * comportamento de antes desta mudança. Degrada para o antigo, nunca para vazio.
 */
export function useMotivosDePerdaDoFunil(pipelineId: string): string[] {
  const qc = useQueryClient();
  // A MESMA chave de `useBoard`, não uma literal igual: literal igual é igual só
  // até alguém mudar um dos lados, e aí este hook devolve `[]` sem erro nenhum.
  const settings = qc.getQueryData<BoardData>(chaveDoQuadro(pipelineId))?.pipeline?.settings ?? null;
  return useMemo(() => motivosDoFunil(settings), [settings]);
}
