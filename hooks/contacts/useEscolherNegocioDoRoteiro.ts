"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * A ESCOLHA do negócio desta execução (#3363), feita por uma pessoa da equipe.
 *
 * Existe porque a decisão de produto veda o default: com mais de um card aberto,
 * a execução não escolhe "o mais recente" — ela fica sem destino até alguém
 * dizer qual é, e essa resposta vale até o roteiro terminar.
 *
 * Invalida o resumo do contato em vez de mexer no cache local: quem decide o
 * vínculo é o servidor (primeiro vence), então a tela relê o que ficou gravado.
 */
export function useEscolherNegocioDoRoteiro(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { enrollmentId: string; leadId: string }) => {
      const r = await apiClient.post<{ data: { lead_id: string } }>(
        `/api/v1/contacts/${contactId}/roteiros/${args.enrollmentId}/negocio`,
        { lead_id: args.leadId },
      );
      return r.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact", contactId, "roteiros"] });
    },
    // Quem não é gestor vê a escolha na ficha e no painel da conversa, e a rota
    // é manager+: sem isto, o 403 (ou o 409 de roteiro que acabou) sumia calado.
    onError: showApiError,
  });
}
