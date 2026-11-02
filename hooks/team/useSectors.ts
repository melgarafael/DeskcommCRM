"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { ATTENDANTS_KEY } from "@/hooks/team/useAttendants";

export interface Sector {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  /** Quantos atendentes estão neste setor agora. */
  member_count: number;
}

const SECTORS_KEY = ["team", "sectors"] as const;

/**
 * Setores de atendimento da org (qualquer membro lê). `ligado = false` quando o
 * módulo opcional está desligado (doc 213): a rota responderia 404, então nem pergunta.
 */
export function useSectors(ligado = true) {
  return useQuery({
    queryKey: SECTORS_KEY,
    enabled: ligado,
    queryFn: async () => apiClient.get<{ data: Sector[] }>("/api/v1/attendants/sectors"),
    staleTime: 30_000,
  });
}

/**
 * Criar, renomear ou apagar mexe nos DOIS lados da tela: a lista de setores e a
 * coluna "Setor" da aba Atendimento (apagar solta os atendentes). Invalidar só
 * um deixaria a outra aba mostrando um setor que não existe mais.
 */
function useInvalidarSetores() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: SECTORS_KEY });
    qc.invalidateQueries({ queryKey: ATTENDANTS_KEY });
  };
}

export function useCreateSector() {
  const t = useT();
  const invalidar = useInvalidarSetores();
  return useMutation({
    mutationFn: async (input: { name: string; description: string | null }) =>
      apiClient.post<{ data: Sector }>("/api/v1/attendants/sectors", input),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Setor criado."));
      invalidar();
    },
  });
}

export function useUpdateSector() {
  const t = useT();
  const invalidar = useInvalidarSetores();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: { name?: string; description?: string | null } }) =>
      apiClient.patch<{ data: Sector }>(`/api/v1/attendants/sectors/${id}`, patch),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Setor atualizado."));
      invalidar();
    },
  });
}

export function useDeleteSector() {
  const t = useT();
  const invalidar = useInvalidarSetores();
  return useMutation({
    mutationFn: async (id: string) =>
      apiClient.delete<{ data: { id: string; deleted: boolean } }>(`/api/v1/attendants/sectors/${id}`),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Setor apagado."));
      invalidar();
    },
  });
}

/** Põe/troca/tira (`null`) o setor de um atendente (manager+; a API enforça). */
export function useAssignSector() {
  const t = useT();
  const invalidar = useInvalidarSetores();
  return useMutation({
    mutationFn: async ({ userId, sectorId }: { userId: string; sectorId: string | null }) =>
      apiClient.put<{ data: { user_id: string; sector_id: string | null } }>(
        `/api/v1/attendants/sector/${userId}`,
        { sector_id: sectorId },
      ),
    onError: (err) => showApiError(err),
    onSuccess: () => {
      toast.success(t("Setor do atendente atualizado."));
      invalidar();
    },
  });
}
