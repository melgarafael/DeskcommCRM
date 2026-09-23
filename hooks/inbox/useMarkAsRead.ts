"use client";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

const DEBOUNCE_MS = 1500;

/**
 * Marca a conversa como lida após permanecer em foco (EPIC-03 S-03.10).
 * Só chama a API quando unread > 0 para evitar writes desnecessários.
 */
export function useMarkAsRead(conversationId: string | null, unread: number) {
  const { user } = useAuth();
  const readonly = user.support?.access_mode === "support_readonly";
  const qc = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { mutate } = useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ data: unknown }>(`/api/v1/conversations/${id}/mark-read`, {}),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", id] });
      // O contador do topo vive em `["conversation-counts", orgId, sufixo]`
      // (useConversationCounts). O casamento por prefixo do react-query compara
      // elemento a elemento: nem `["conversations"]` nem `["conversation", id]`
      // alcançam essa família — era por isso que o negrito sumia e o número
      // ficava parado até recarregar a página. Invalidar a família inteira
      // acompanha também os sufixos que não estão na tela agora.
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });
    },
  });

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (readonly || !conversationId || unread <= 0) return;

    timerRef.current = setTimeout(() => {
      mutate(conversationId);
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [conversationId, unread, mutate, readonly]);
}
