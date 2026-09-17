"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

const MEMBERS_KEY = ["team", "members"] as const;

/**
 * Revoga o acesso de um membro.
 *
 * OTIMISTA pelo mesmo motivo de `useReactivateMember`: desde que o revogado
 * passou a FICAR na lista (antes ele era filtrado fora pela rota), só invalidar
 * deixava a linha parada até alguém recarregar a página — e quem clicava não
 * via nada acontecer. Medido pela tela em 2026-09-10.
 */
export function useRevokeMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{ data: { user_id: string; revoked_at?: string; already_revoked?: boolean } }>(
        `/api/v1/team/${userId}/revoke`,
        {},
      ),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: MEMBERS_KEY });
      const previous = qc.getQueryData<{ data: TeamMember[] }>(MEMBERS_KEY);
      qc.setQueryData<{ data: TeamMember[] }>(MEMBERS_KEY, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((m) =>
                m.user_id === userId ? { ...m, revoked_at: new Date().toISOString() } : m,
              ),
            }
          : old,
      );
      return { previous };
    },
    onError: (err, _userId, context) => {
      if (context?.previous) qc.setQueryData(MEMBERS_KEY, context.previous);
      showApiError(err);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
