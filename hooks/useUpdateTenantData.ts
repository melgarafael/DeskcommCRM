"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRouter } from "next/navigation";

import { apiClient } from "@/lib/api/client";
import type { TenantInput } from "@/lib/schemas/settings";

/**
 * Grava os dados cadastrais de um tenant pela rota do admin da plataforma
 * (`PATCH /api/v1/admin/tenants/[id]`). Devolve o MESMO contrato da server
 * action de Configurações › Empresa, para o `TenantForm` servir às duas portas.
 */
export function useUpdateTenantData(id: string) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useCallback(
    async (dados: TenantInput): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiClient.patch(`/api/v1/admin/tenants/${id}`, dados);
        void queryClient.invalidateQueries({ queryKey: ["admin", "tenant", id] });
        void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
        router.refresh();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [id, queryClient, router],
  );
}
