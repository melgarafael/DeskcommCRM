"use client";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationListItem } from "./ConversationListItem";
import { EmptyInbox } from "@/components/empty";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

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
  const q = useConversationsRealtime(filters, orgId);

  const items = useMemo(() => {
    const all: ConversationWithContact[] = q.data?.pages.flatMap((p) => p.data) ?? [];
    return clientFilter ? all.filter(clientFilter) : all;
  }, [q.data, clientFilter]);

  // Notify parent of currently-visible IDs (for j/k nav).
  useMemo(() => {
    if (onVisibleChange) onVisibleChange(items.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

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
      <div className="flex-1 overflow-y-auto">
        {items.map((c) => (
          <ConversationListItem
            key={c.id}
            conversation={c}
            isSelected={c.id === selectedId}
            onSelect={onSelect}
          />
        ))}
        {q.hasNextPage && (
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
        )}
      </div>
    </div>
  );
}
