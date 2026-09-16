"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface ConversationCounts {
  /**
   * OPCIONAIS de propósito: um cache de react-query gravado antes deste deploy
   * não tem estes campos, e a tela lê o cache antes da primeira resposta nova.
   * Marcá-los obrigatórios daria `undefined` onde o tipo promete `number` — e o
   * badge imprimiria "NaN" no primeiro segundo depois de atualizar.
   */
  fila?: number;
  automatico?: number;
  /** Nome antigo de `fila`, mantido pela rota versionada. Prefira `fila`. */
  unassigned: number;
  mine: number;
  all: number;
  /** Opcional pelo mesmo motivo dos de cima: cache gravado antes deste deploy não tem. */
  closed?: number;
}

/** Os filtros auxiliares ligados na barra, que a contagem tem de aplicar junto. */
export interface FiltrosDaContagem {
  unread?: boolean;
  tag?: string;
  channel_session_id?: string;
}

/**
 * Contagens por visão do inbox (G4-02). O endpoint usa o client RLS-scoped —
 * um agent em modo own* recebe a contagem do seu escopo, não o total da org.
 */
export function useConversationCounts(
  orgId: string | null,
  filtros: FiltrosDaContagem = {},
) {
  const qs = new URLSearchParams();
  if (filtros.unread) qs.set("unread", "true");
  if (filtros.tag) qs.set("tag", filtros.tag);
  if (filtros.channel_session_id) qs.set("channel_session_id", filtros.channel_session_id);
  const sufixo = qs.toString();

  return useQuery({
    // ⚠️ OS FILTROS ENTRAM NA CHAVE. Sem isso o react-query devolveria a contagem
    // guardada para OUTRO conjunto de filtros, sem ir ao servidor — e o badge
    // voltaria a mentir, agora pelo cache. Seria o mesmo defeito por outra porta.
    queryKey: ["conversation-counts", orgId, sufixo],
    enabled: !!orgId,
    refetchInterval: 30_000,
    queryFn: () =>
      apiClient
        .get<{ data: ConversationCounts }>(
          `/api/v1/conversations/counts${sufixo ? `?${sufixo}` : ""}`,
        )
        .then((r) => r.data),
  });
}
