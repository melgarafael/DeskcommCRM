"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface NovoAgendamento {
  event_type_id: string;
  /** ISO-8601 com offset. */
  starts_at: string;
  owner_user_id?: string;
  contact_id?: string;
  title?: string;
  notes?: string;
  /**
   * Convidado externo. Vazio ou ausente cria o evento como sempre foi — sem
   * `attendees` e sem convite nenhum saindo do Google.
   */
  guest_email?: string;
}

/**
 * Marca de verdade — `POST /api/v1/agenda/agendamentos`.
 *
 * Até este hook existir, o "Marcado ✓" que a tela mostrava era **estado local do
 * React**: `PainelDeMarcacao` chama `onConfirmar?.()`, a prop é OPCIONAL, e nem
 * a vitrine nem a tela do produto a passavam. A máquina de três tempos estava
 * provada; a criação da linha, não. Achado do maestro na auditoria dos dez itens.
 *
 * O `showApiError` cuida da recusa: os códigos de agenda já têm TOM declarado no
 * `ApiErrorToast` (warning para recusa esperada, error para configuração
 * quebrada) e deixam passar a mensagem da rota, que é mais específica do que
 * qualquer frase genérica — ela tem o nome do tipo e o motivo.
 */
export function useMarcarAgendamento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (novo: NovoAgendamento) => {
      return apiClient.post<{ data: { id: string } }>("/api/v1/agenda/agendamentos", novo);
    },
    onSuccess: () => {
      // Sem exclamação e sem emoji — anti-pattern declarado do design system.
      toast.success("Agendamento criado.");
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: (err) => showApiError(err),
  });
}
