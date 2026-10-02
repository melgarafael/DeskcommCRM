"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { avisarSeNadaMudou, type ResultadoDaTransicao } from "@/hooks/avisarSeNadaMudou";

export interface ReactivateTenantPayload {
  id: string;
  reason: string;
}

export function useReactivateTenant() {
  const t = useT();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }: ReactivateTenantPayload) =>
      apiClient.post<ResultadoDaTransicao>(`/api/v1/admin/tenants/${id}/reactivate`, { reason }),
    onSuccess: (resposta, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenant", variables.id] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      if (!avisarSeNadaMudou(resposta, t)) toast.success(t("Tenant reativado com sucesso"));
    },
    onError: (err: Error) => {
      toast.error(t("Erro ao reativar tenant"), { description: err.message });
    },
  });
}
