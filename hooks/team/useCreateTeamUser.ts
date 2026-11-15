"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { CreateTeamUserInput } from "@/lib/schemas/team";

interface CreateTeamUserResult {
  data: {
    user_id: string;
    email: string;
    role: string;
    deve_trocar_senha: boolean;
  };
}

/**
 * POST /api/v1/team/users — a pessoa criada sem convite (#3876).
 *
 * Invalida `team` como o convite faz: a lista de membros e a de pendentes
 * passam a mostrar a pessoa na hora, sem recarregar a página.
 */
export function useCreateTeamUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTeamUserInput) =>
      apiClient.post<CreateTeamUserResult>("/api/v1/team/users", input),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
