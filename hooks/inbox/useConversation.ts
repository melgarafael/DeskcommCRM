"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { ConversationWithContact } from "./useConversationsRealtime";

/**
 * Busca uma conversa por id (G4-02, GAP D). RLS-scoped: uma conversa fora do
 * escopo do agent (own*) volta 404 — o caller distingue "not found" de "carregando"
 * para renderizar um estado vazio claro em deep-link, sem stack trace. `retry:false`
 * evita re-tentar o 404.
 */
export function useConversation(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["conversation", id],
    enabled: enabled && !!id,
    retry: false,
    queryFn: () =>
      apiClient
        .get<{ data: ConversationWithContact }>(`/api/v1/conversations/${id}`)
        .then((r) => r.data),
  });
}

/** true quando o erro é um 404 (conversa inexistente ou fora do escopo). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
