"use client";
import type { InterfaceSettings } from "@/lib/navigation/interface";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { StatusConvite } from "@/lib/team/convite-status";

export interface TeamInvite {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  interface_settings: InterfaceSettings;
  invited_by: string | null;
  inviter_name: string | null;
  email_dispatched: boolean;
  created_at: string;
  last_sent_at: string;
  resend_count: number;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  status: StatusConvite;
  accept_url: string | null;
}

export function useTeamInvites(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["team", "invites"],
    queryFn: async () => apiClient.get<{ data: TeamInvite[] }>("/api/v1/team/invites"),
    staleTime: 30_000,
    enabled: opts?.enabled ?? true,
  });
}
