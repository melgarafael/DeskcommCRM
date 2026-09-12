"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface SuspendTenantPayload {
  id: string;
  reason: string;
}

export function useSuspendTenant() {
  const t = useT();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }: SuspendTenantPayload) =>
      apiClient.post(`/api/v1/admin/tenants/${id}/suspend`, { reason }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenant", variables.id] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      toast.success(t("Tenant suspenso com sucesso"));
    },
    onError: (err: Error) => {
      toast.error(t("Erro ao suspender tenant"), { description: err.message });
    },
  });
}
