"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { Conversation } from "@/lib/types/messaging";

/**
 * O mínimo que a lista precisa de cada conversa do contato — o que a rota
 * `GET /api/v1/conversations?contact_id=…` já devolve (`SELECT_COLS` do
 * `_handler`, com o número embutido).
 */
export type ConversaDoContato = Pick<
  Conversation,
  "id" | "channel_session_id" | "status" | "last_message_at" | "assigned_to_user_name"
> & {
  channel_sessions?: {
    phone_number: string | null;
    display_name: string | null;
    provider: string | null;
  } | null;
};

/**
 * AS OUTRAS CONVERSAS DO MESMO CONTATO (#4312, defeito 3).
 *
 * O contato abre outra conversa e a equipe perde o fio: ele escreve pelo número
 * B, nasce uma conversa em B, e quem transfere a conversa antiga não sabe que a
 * nova existe. A lista vive no DIÁLOGO de Transferir (não nasce um segundo
 * seletor na conversa), com o número de cada uma, e abrir leva para a conversa
 * certa.
 *
 * A leitura é a rota que já existe, pelo cliente da SESSÃO: a RLS de
 * `conversations` decide o que quem transfere enxerga — nada de lista paralela
 * com privilégio a mais.
 */
export function useConversasDoContato(contactId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["conversas-do-contato", contactId],
    queryFn: async () => {
      const qs = new URLSearchParams({ contact_id: contactId as string, limit: "20" });
      const res = await apiClient.get<{ data: ConversaDoContato[] }>(`/api/v1/conversations?${qs.toString()}`);
      return res.data;
    },
    enabled: enabled && !!contactId,
    staleTime: 30_000,
  });
}
