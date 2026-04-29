"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface ApproveInput {
  id: string;
  approved_reason: string;
}

interface ApproveResponse {
  data: {
    request_id: string;
    status: "processing";
  };
}

export function useApproveLgpdRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, approved_reason }: ApproveInput) => {
      const idempotencyKey = crypto.randomUUID();
      return apiClient.post<ApproveResponse>(
        `/api/v1/lgpd/requests/${id}/approve`,
        { approved_reason },
        { idempotencyKey },
      );
    },
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ["lgpd-request", id] });
      void queryClient.invalidateQueries({ queryKey: ["lgpd-requests"] });
    },
  });
}
