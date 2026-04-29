"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export function useRevokeMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{ data: { user_id: string; revoked_at?: string; already_revoked?: boolean } }>(
        `/api/v1/team/${userId}/revoke`,
        {},
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
