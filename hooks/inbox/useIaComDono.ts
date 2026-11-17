"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

interface ModoArgs {
  conversation_id: string;
  ligado: boolean;
}

interface ModoResponse {
  data: { ai_com_dono: boolean; dono_preservado: string | null };
}

/**
 * Liga/desliga o modo "IA com o dono" nesta conversa (#3967).
 *
 * O estado mora em `conversations.metadata.ai_com_dono` e chega junto com a
 * conversa no payload do Inbox — a tela não precisa de leitura nova, então aqui
 * só existe a ESCRITA.
 *
 * Não invalida `conversation-counts`: o modo não muda dono, fila nem status, e
 * por isso não move a conversa entre abas. É justamente esse o ponto da issue, e
 * um refetch de contagem aqui sugeriria o contrário.
 */
export function useIaComDono() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: ModoArgs) =>
      apiClient.post<ModoResponse>(`/api/v1/conversations/${args.conversation_id}/ia-com-dono`, {
        ligado: args.ligado,
      }),
    onError: (err) => showApiError(err),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
