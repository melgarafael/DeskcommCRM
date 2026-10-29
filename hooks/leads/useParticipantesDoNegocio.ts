"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { chaveDosContatosRelacionados } from "@/hooks/leads/useContatosRelacionados";

/**
 * O ESCRITOR do vínculo `crm_lead_links` com `target_kind='contact'` (#3083,
 * fatia 1) — o que faltava para a lista "Pessoas relacionadas" deixar de ser só
 * leitura.
 *
 * `POST` e `DELETE` moram na MESMA rota do leitor, e o motivo é a invalidação:
 * a escrita tem que derrubar a MESMA entrada de cache que o dossiê já está
 * lendo. Uma rota nova (`/participantes`) obrigaria a tela a manter duas
 * fontes da mesma lista.
 *
 * O papel é texto livre (teto de 40, no servidor): mandar `null` LIMPA o papel
 * sem tirar a pessoa — é o mesmo POST, e o servidor faz upsert no índice único.
 */
export function useAdicionarParticipante(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entrada: { contact_id: string; papel?: string | null }) =>
      apiClient.post<unknown>(`/api/v1/leads/${leadId}/contatos-relacionados`, entrada),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chaveDosContatosRelacionados(leadId) });
    },
    onError: (err) => showApiError(err),
  });
}

/** O alvo do DELETE viaja na query: DELETE com corpo não é portátil. */
export function useRemoverParticipante(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.delete<unknown>(
        `/api/v1/leads/${leadId}/contatos-relacionados?contact_id=${encodeURIComponent(contactId)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chaveDosContatosRelacionados(leadId) });
    },
    onError: (err) => showApiError(err),
  });
}
