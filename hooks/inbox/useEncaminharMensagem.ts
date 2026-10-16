"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * Encaminhar uma mensagem para outra conversa (#2835).
 *
 * A tela NÃO manda o conteúdo: manda só `conversation_id` de destino — o texto
 * e/ou a mídia vêm da própria mensagem de origem, lidos no servidor por
 * `lib/inbox/encaminhar-mensagem`, que reusa o mesmo caminho de envio do Inbox.
 * Mandar o corpo daqui duplicaria a fonte da verdade (e deixaria a tela
 * encaminhar qualquer coisa que ela inventasse).
 */
export function useEncaminharMensagem() {
  const qc = useQueryClient();
  const t = useT();

  return useMutation({
    mutationFn: ({ id, conversationIdDestino }: { id: string; conversationIdDestino: string }) =>
      apiClient.post(`/api/v1/messages/${id}/forward`, { conversation_id: conversationIdDestino }),
    onSuccess: (_data, vars) => {
      // O fio do DESTINO ganha a mensagem; a conversa de origem não muda. As
      // duas chaves são invalidadas de propósito — a lista precisa refletir o
      // preview novo na conversa que recebeu.
      qc.invalidateQueries({ queryKey: ["messages", vars.conversationIdDestino] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("Mensagem encaminhada."));
    },
    onError: showApiError,
  });
}
