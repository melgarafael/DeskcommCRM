"use client";
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { TenantAgentsResponse } from "@/app/api/v1/admin/tenants/[id]/agents/route";
import { apiClient } from "@/lib/api/client";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

export type { TenantAgentsResponse };

interface AgentsApiResponse {
  data: TenantAgentsResponse;
}

export function useTenantAgent(id: string) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "tenant", id, "agents"] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<AgentsApiResponse>(`/api/v1/admin/tenants/${id}/agents`),
    staleTime: 30_000,
    enabled: !!id,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, id]);

  useRealtimeChannel({
    name: id ? `tenant-agents-${id}` : "tenant-agents-disabled",
    broadcast: { event: "*" },
    onChange: invalidate,
    enabled: !!id,
  });

  return query;
}
