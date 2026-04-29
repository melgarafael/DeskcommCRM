"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Role } from "@/lib/schemas/team";

export function useChangeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { userId: string; role: Role }) =>
      apiClient.patch<{ data: { user_id: string; role: Role } }>(
        `/api/v1/team/${args.userId}/role`,
        { role: args.role },
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
