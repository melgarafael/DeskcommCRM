"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface AssignableMember {
  user_id: string;
  role: string;
  full_name: string | null;
}

/** G3-01: destinos válidos de transferência (membros ativos agent+ da org). */
export function useAssignableMembers(enabled: boolean) {
  return useQuery({
    queryKey: ["team", "assignable"],
    queryFn: async () =>
      (await apiClient.get<{ data: AssignableMember[] }>("/api/v1/team/assignable")).data,
    enabled,
    staleTime: 60_000,
  });
}
