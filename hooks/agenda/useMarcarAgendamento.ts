"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

export interface NovoAgendamento {
  event_type_id: string;
  /** ISO-8601 com offset. */
  starts_at: string;
  /**
   * A duração escolhida na tela, em minutos — ausente, a do serviço (#3709).
   *
   * É o comprimento do bloco (`ends_at = starts_at + duration_minutes`) e o que
   * a rota confere como horário livre: a lista de horários já veio calculada
   * para esta duração, e mandar outra aqui faria a tela marcar um horário que a
   * regra não ofereceu.
   */
  duration_minutes?: number;
  owner_user_id?: string;
  contact_id?: string;
  conversation_id?: string;
  title?: string;
  notes?: string;
  /** Observação visível no calendário (`description` do evento). */
  description?: string;
  /** Endereço/local deste compromisso. Vazio grava sem local. */
  location_details?: string;
  /**
   * Convidado externo. O e-mail da ficha do cliente já entra no convite do
   * Google quando existe. Vazio ou ausente não convida outra pessoa.
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
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (novo: NovoAgendamento) => {
      return apiClient.post<{ data: { id: string } }>("/api/v1/agenda/agendamentos", novo);
    },
    onSuccess: () => {
      // Sem exclamação e sem emoji — anti-pattern declarado do design system.
      toast.success(t("Agendamento criado."));
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: (err) => showApiError(err),
  });
}
