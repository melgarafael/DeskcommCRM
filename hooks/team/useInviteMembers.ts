"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { InviteMemberInput } from "@/lib/schemas/team";

interface InviteResult {
  data: {
    sent: Array<{
      email: string;
      invite_id: string;
      expires_at: string;
      email_dispatched: boolean;
      accept_url: string;
    }>;
    failed: Array<{ email: string; reason: string }>;
  };
}

export function useInviteMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: InviteMemberInput) =>
      apiClient.post<InviteResult>("/api/v1/team/invite", input),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
