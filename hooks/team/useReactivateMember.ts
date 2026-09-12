"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/** O inverso de `useRevokeMember`. Espelho dele, de propósito. */
export function useReactivateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{
        data: { user_id: string; reactivated_at?: string; already_active?: boolean };
      }>(`/api/v1/team/${userId}/reactivate`, {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
