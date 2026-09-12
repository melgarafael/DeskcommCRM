"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { TeamInvite } from "./useTeamInvites";

export function useResendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiClient.post<{ data: TeamInvite }>(`/api/v1/team/invites/${id}/resend`, {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
