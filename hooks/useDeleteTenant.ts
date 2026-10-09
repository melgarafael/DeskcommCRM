"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface DeleteTenantPayload {
  id: string;
  /** O slug da organização, digitado como confirmação. */
  confirmacao: string;
  motivo: string;
}

/** O que a exclusão devolve — ver `ResultadoDaExclusao` em `lib/tenants/exclusao.ts`. */
export interface ResultadoDaExclusaoNaTela {
  slug: string;
  contagens: Record<string, number>;
  canais: Array<{ id: string; provedor: string; desfecho: "ok" | "falhou" | "nao_se_aplica" }>;
  voz: "ok" | "falhou" | "nao_se_aplica";
  nuvemshop: "ok" | "falhou" | "nao_se_aplica";
  arquivos: { encontrados: number; removidos: number; falhas: number };
  usuarios: { removidos: string[]; mantidos: Array<{ id: string; motivo: string }> };
}

export function useDeleteTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmacao, motivo }: DeleteTenantPayload) =>
      apiClient.post<{ data: ResultadoDaExclusaoNaTela }>(`/api/v1/admin/tenants/${id}/delete`, {
        confirmacao,
        motivo,
      }),
    onSuccess: (_data, variables) => {
      queryClient.removeQueries({ queryKey: ["admin", "tenant", variables.id] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
    },
  });
}
