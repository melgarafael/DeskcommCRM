"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface TeamMember {
  user_id: string;
  role: string;
  invited_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  email: string | null;
  full_name: string | null;
  last_sign_in_at: string | null;
}

export function useTeamMembers(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["team", "members"],
    queryFn: async () =>
      apiClient.get<{ data: TeamMember[] }>("/api/v1/team"),
    staleTime: 30_000,
    enabled: opts?.enabled ?? true,
  });
}
