"use client";
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useNoticeSignal } from "@/hooks/realtime/useNoticeSignal";
import type { TenantHealthResponse } from "@/app/api/v1/admin/tenants/[id]/health/route";

export type { TenantHealthResponse };

interface HealthApiResponse {
  data: TenantHealthResponse;
}

export function useTenantHealth(id: string) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "tenant", id, "health"] as const;

  const query = useQuery({
    queryKey,
    queryFn: () =>
      apiClient.get<HealthApiResponse>(`/api/v1/admin/tenants/${id}/health`),
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: !!id,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, id]);

  // Pelo hook compartilhado: `.channel()` cru assina como ANÔNIMO (cookie de
  // sessão httpOnly), recebe "ok" e nunca entrega evento. A correção mora em
  // `useRealtimeChannel`, que chama `setAuth` antes do `subscribe`.
  useNoticeSignal("tenant_health", invalidate, id, !!id);

  return query;
}
