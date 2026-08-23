"use client";
import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";

import { ConversationListItem } from "./ConversationListItem";
import { EmptyInbox } from "@/components/empty";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

/** Estimativa antes da primeira medição real (`measureElement` corrige depois).
 *  Linha sem fila/tags mede ~76px; com badge de fila ou tags sobe uns 20px —
 *  84 fica no meio, então a primeira pintura sub-mede menos do que super-mede. */
const ESTIMATED_ROW_HEIGHT = 84;
const LOADER_ROW_KEY = "__load-more__";

interface Props {
  filters: ConversationsFilters;
  orgId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional client-side filter (e.g. only-unread). */
  clientFilter?: (c: ConversationWithContact) => boolean;
  /** Notifies parent when the visible list changes (used by keyboard nav). */
  onVisibleChange?: (ids: string[]) => void;
}

export function ConversationList({
  filters,
  orgId,
  selectedId,
  onSelect,
  clientFilter,
  onVisibleChange,
}: Props) {
  // Só mostra POR ONDE a conversa entrou quando há mais de um número. Com um
  // só, o rótulo seria a mesma palavra em toda linha — ruído que ensina o olho
  // a ignorar a área onde vivem os avisos que importam.
  //
  // `?? []` e não `undefined`: enquanto a lista de canais carrega, o certo é
  // NÃO mostrar. Mostrar e sumir depois é pior que aparecer um instante tarde.
  const canais = useChannelSessions().data ?? [];
  const maisDeUmCanal = canais.length > 1;

  const q = useConversationsRealtime(filters, orgId);

  // Fila (G5-03): a lista já vem ordenada por tempo de espera (server), então a
  // posição é o índice na lista visível. Só mostramos posição/espera nessa visão.
  const isQueue = filters.assigned_to === "unassigned";

  const items = useMemo(() => {
    const all: ConversationWithContact[] = q.data?.pages.flatMap((p) => p.data) ?? [];
    return clientFilter ? all.filter(clientFilter) : all;
  }, [q.data, clientFilter]);

  // Notify parent of currently-visible IDs (for j/k nav). Must use effect
  // (not render-time call) — invoking onVisibleChange during render triggers
  // setState in InboxLayout from inside ConversationList's render phase,
  // which React 19 forbids.
  useEffect(() => {
    if (onVisibleChange) onVisibleChange(items.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Uma linha "virtual" extra pro botão "Carregar mais" quando existe próxima
  // página — assim ele rola junto com a lista em vez de furar o container
  // virtualizado (que precisa ser o único filho medido/posicionado do scroll).
  const hasLoaderRow = !!q.hasNextPage;
  const rowCount = items.length + (hasLoaderRow ? 1 : 0);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    // Chave por identidade da conversa (não índice): com Realtime, uma
    // conversa que recebe mensagem nova pula para o topo da lista — sem a
    // key certa, o cache de medição do virtualizer atribuiria a ALTURA MEDIDA
    // de uma linha à conversa que ocupa o índice agora, não à que a mediu.
    getItemKey: (index) => items[index]?.id ?? LOADER_ROW_KEY,
  });

  // Rola até a conversa selecionada quando ela existe na lista mas está fora
  // da janela renderizada (ex.: navegação por j/k além do overscan). `auto`
  // só move o scroll se o item já não estiver visível — clique numa linha já
  // visível não causa salto.
  useEffect(() => {
    if (!selectedId) return;
    const idx = items.findIndex((c) => c.id === selectedId);
    if (idx === -1) return;
    rowVirtualizer.scrollToIndex(idx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>Erro ao carregar conversas.</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => q.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyInbox />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const isLoaderRow = virtualRow.index >= items.length;
            const conversation = items[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {isLoaderRow || !conversation ? (
                  <div className="flex justify-center p-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => q.fetchNextPage()}
                      disabled={q.isFetchingNextPage}
                    >
                      {q.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
                    </Button>
                  </div>
                ) : (
                  <ConversationListItem
                    conversation={conversation}
                    isSelected={conversation.id === selectedId}
                    onSelect={onSelect}
                    queuePosition={isQueue ? virtualRow.index + 1 : undefined}
                    mostrarCanal={maisDeUmCanal}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
