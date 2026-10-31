"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface NumeroDaTransferencia {
  channel_session_id: string;
  display_name: string | null;
  phone_number: string | null;
}

/**
 * Por qual número a conversa vai continuar se for transferida para `toUserId`
 * (#3642, doc 237, escolha 2-A). `null` = ela fica no número em que está. A
 * resposta é a mesma regra que a transferência aplica (`fn_numero_da_transferencia`).
 */
export function useNumeroDaTransferencia(conversationId: string, toUserId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["conversation", conversationId, "numero-da-transferencia", toUserId],
    queryFn: async () =>
      apiClient.get<{ data: { numero: NumeroDaTransferencia | null } }>(
        `/api/v1/conversations/${conversationId}/transfer?to_user_id=${encodeURIComponent(toUserId)}`,
      ),
    enabled: enabled && toUserId !== "",
    select: (res) => res.data.numero,
  });
}
