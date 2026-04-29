"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AdminIncidentRow } from "./useAdminIncidents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditEntry {
  id: string;
  action: string;
  actor_user_id: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
  request_id: string | null;
}

export interface AdminIncidentDetail extends AdminIncidentRow {
  tenant: {
    id: string;
    display_name: string;
    slug: string;
    status: string;
  } | null;
  audit_trail: AuditEntry[];
}

interface DetailResponse {
  data: AdminIncidentDetail;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAdminIncident(id: string) {
  return useQuery({
    queryKey: ["admin", "incident", id] as const,
    queryFn: () =>
      apiClient.get<DetailResponse>(`/api/v1/admin/incidents/${id}`),
    staleTime: 30_000,
    enabled: Boolean(id),
  });
}
