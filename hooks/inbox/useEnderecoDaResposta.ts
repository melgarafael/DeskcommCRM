"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/** Para qual número a resposta desta conversa vai sair (Spec 31, B2 item 4). */
export interface EnderecoDaResposta {
  phone_number: string | null;
  via: "ultima_recebida" | "principal";
  has_extras: boolean;
  provider: string | null;
}

/**
 * `ultimaEntrada` entra na chave de propósito: quando chega mensagem nova, o
 * número por onde ela entrou pode ter mudado, e a resposta precisa ser relida.
 */
export function useEnderecoDaResposta(conversationId: string, ultimaEntrada: string | null) {
  return useQuery({
    queryKey: ["conversation-reply-address", conversationId, ultimaEntrada],
    enabled: !!conversationId,
    queryFn: async () => {
      try {
        return await apiClient.get<{ data: EnderecoDaResposta }>(
          `/api/v1/conversations/${conversationId}/reply-address`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
