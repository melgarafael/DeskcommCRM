"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface NumeroDaTransferencia {
  channel_session_id: string;
  display_name: string | null;
  phone_number: string | null;
}

/**
 * O NEGÓCIO aberto do contato nesta transferência (#4312): `leva` diz se ele
 * acompanha a conversa, e `dono_user_id` com quem ele fica quando não acompanha.
 */
export interface NegocioDaTransferencia {
  leva: boolean;
  dono_user_id: string | null;
}

/**
 * A PRÉVIA da transferência, para o destino escolhido: por qual número a
 * conversa continua (#3642, doc 237, escolha 2-A) e o que acontece com o
 * negócio aberto do contato (#4312). `numero: null` = a conversa fica no número
 * em que está; `negocio: null` = o contato não tem exatamente um negócio aberto,
 * e não há o que avisar.
 *
 * UMA requisição para as duas respostas: a rota consulta as duas funções que a
 * transferência aplica (`fn_numero_da_transferencia` e
 * `fn_previa_do_negocio_na_transferencia`), então o aviso nunca diz uma coisa
 * enquanto a troca grava outra.
 */
export interface PreviaDaTransferencia {
  numero: NumeroDaTransferencia | null;
  negocio: NegocioDaTransferencia | null;
}

export function usePreviaDaTransferencia(conversationId: string, toUserId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["conversation", conversationId, "previa-da-transferencia", toUserId],
    queryFn: async () =>
      apiClient.get<{ data: PreviaDaTransferencia }>(
        `/api/v1/conversations/${conversationId}/transfer?to_user_id=${encodeURIComponent(toUserId)}`,
      ),
    enabled: enabled && toUserId !== "",
    select: (res) => res.data,
  });
}
