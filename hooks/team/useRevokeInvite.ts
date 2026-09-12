"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiClient.post<{ data: { id: string; revoked_at?: string; already_revoked?: boolean } }>(
        `/api/v1/team/invites/${id}/revoke`,
        {},
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
