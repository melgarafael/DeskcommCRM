"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AvailabilitySchedule, RoutingConfig } from "@/lib/schemas/routing";

export interface AttendantAvailability {
  user_id: string;
  role: string | null;
  name: string | null;
  email: string | null;
  is_available: boolean;
  /** null = atendente ainda sem linha de availability (nunca configurado). */
  capacity: number | null;
  schedule: AvailabilitySchedule;
  last_heartbeat_at: string | null;
  updated_at: string | null;
  /** Conversas abertas atribuídas (G5-04): a mesma carga que o router usa. */
  current_load: number;
}

const ATTENDANTS_KEY = ["team", "attendants"] as const;
const ROUTING_KEY = ["settings", "routing"] as const;

/** Disponibilidade + carga da equipe (org-wide, agent+). */
export function useAttendants() {
  return useQuery({
    queryKey: ATTENDANTS_KEY,
    queryFn: async () =>
      apiClient.get<{ data: AttendantAvailability[] }>("/api/v1/attendants/availability"),
    staleTime: 15_000,
  });
}

export interface AvailabilityUpdate {
  is_available?: boolean;
  capacity?: number;
  schedule?: AvailabilitySchedule;
}

/** PATCH disponibilidade de um atendente (próprio OU manager+; a API enforça). */
export function useUpdateAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, patch }: { userId: string; patch: AvailabilityUpdate }) =>
      apiClient.patch<{ data: AttendantAvailability }>(
        `/api/v1/attendants/availability/${userId}`,
        patch,
      ),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success("Atendente atualizado.");
      qc.invalidateQueries({ queryKey: ATTENDANTS_KEY });
    },
  });
}

/** Config de roteamento da org (manager+). */
export function useRoutingConfig() {
  return useQuery({
    queryKey: ROUTING_KEY,
    queryFn: async () => apiClient.get<{ data: RoutingConfig }>("/api/v1/settings/routing"),
    staleTime: 30_000,
  });
}

/** PATCH do modo/knobs de roteamento (manager+; a API enforça). */
export function useUpdateRouting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: RoutingConfig) =>
      apiClient.patch<{ data: RoutingConfig }>("/api/v1/settings/routing", config),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success("Roteamento atualizado.");
      qc.invalidateQueries({ queryKey: ROUTING_KEY });
    },
  });
}
