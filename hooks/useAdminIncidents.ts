"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IncidentSeverity = "info" | "warning" | "critical";
export type IncidentStatus = "open" | "acknowledged" | "resolved";

export interface AdminIncidentRow {
  id: string;
  organization_id: string | null;
  type: string;
  severity: IncidentSeverity;
  payload: Record<string, unknown>;
  status: IncidentStatus;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
  tenant_name: string | null;
  tenant_slug: string | null;
}

export interface AdminIncidentsFilters {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  tenant_id?: string;
}

interface ListResponse {
  data: AdminIncidentRow[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAdminIncidents(filters: AdminIncidentsFilters = {}) {
  return useInfiniteQuery({
    queryKey: ["admin", "incidents", filters] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      qs.set("status", filters.status ?? "open");
      if (filters.severity) qs.set("severity", filters.severity);
      if (filters.tenant_id) qs.set("tenant_id", filters.tenant_id);
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "30");
      return apiClient.get<ListResponse>(
        `/api/v1/admin/incidents?${qs.toString()}`,
      );
    },
    getNextPageParam: (last) =>
      last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined,
    staleTime: 30_000,
  });
}
