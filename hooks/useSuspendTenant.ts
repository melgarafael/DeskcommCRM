"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
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
  // O cabeçalho da página do tenant (nome e selo de status) é Server Component:
  // sem o refresh ele seguiria mostrando o estado anterior à mutação.
  const router = useRouter();

  return useMutation({
    mutationFn: ({ id, reason }: SuspendTenantPayload) =>
      apiClient.post(`/api/v1/admin/tenants/${id}/suspend`, { reason }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenant", variables.id] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
      router.refresh();
      toast.success(t("Tenant suspenso com sucesso"));
    },
    onError: (err: Error) => {
      toast.error(t("Erro ao suspender tenant"), { description: err.message });
    },
  });
}
