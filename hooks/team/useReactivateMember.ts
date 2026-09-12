"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

const MEMBERS_KEY = ["team", "members"] as const;

/**
 * Devolve o acesso de um membro revogado — o inverso de `useRevokeMember`.
 *
 * ─── Por que OTIMISTA, e não só invalidar ───────────────────────────────────
 *
 * Achado pela tela em 2026-09-10: só invalidar deixava a linha parada até
 * alguém recarregar a página. Quem clicava não via nada acontecer e clicava de
 * novo.
 *
 * Antes desta mudança o defeito era invisível: o revogado SUMIA da lista (a
 * rota o filtrava fora), então qualquer atraso de atualização parecia efeito.
 * Agora que a linha fica e só o estado muda, a atualização tem de ser imediata
 * — senão a tela mente sobre o que acabou de acontecer.
 *
 * Mesmo desenho de `useChangeRole`: pinta na hora, desfaz se o servidor
 * recusar, e reconcilia no fim.
 */
export function useReactivateMember() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{
        data: { user_id: string; reactivated_at?: string; already_active?: boolean };
      }>(`/api/v1/team/${userId}/reactivate`, {}),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: MEMBERS_KEY });
      const previous = qc.getQueryData<{ data: TeamMember[] }>(MEMBERS_KEY);
      qc.setQueryData<{ data: TeamMember[] }>(MEMBERS_KEY, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((m) =>
                m.user_id === userId ? { ...m, revoked_at: null } : m,
              ),
            }
          : old,
      );
      return { previous };
    },
    onError: (err, _userId, context) => {
      // Desfaz: sem isto a tela ficaria dizendo "ativo" para alguém que o
      // servidor recusou reativar — pior que não ter atualizado.
      if (context?.previous) qc.setQueryData(MEMBERS_KEY, context.previous);
      showApiError(err);
    },
    onSuccess: () => {
      // Revogar avisa; devolver nao avisava. Achado pela tela: quem clicava
      // ficava sem confirmacao de que o clique valeu — e a acao e justamente
      // a que a pessoa faz com receio de ter errado.
      toast.success(t("Acesso devolvido."));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
