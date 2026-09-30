"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface ReactivateTenantPayload {
  id: string;
  reason: string;
}

export function useReactivateTenant() {
  const t = useT();
  const queryClient = useQueryClient();
  // O cabeçalho da página do tenant (nome e selo de status) é Server Component:
  // sem o refresh ele seguiria mostrando o estado anterior à mutação.
  const router = useRouter();

  return useMutation({
    mutationFn: ({ id, reason }: ReactivateTenantPayload) =>
      apiClient.post(`/api/v1/admin/tenants/${id}/reactivate`, { reason }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenant", variables.id] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      router.refresh();
      toast.success(t("Tenant reativado com sucesso"));
    },
    onError: (err: Error) => {
      toast.error(t("Erro ao reativar tenant"), { description: err.message });
    },
  });
}
