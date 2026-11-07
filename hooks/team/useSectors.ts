"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { AvailabilitySchedule } from "@/lib/schemas/routing";
import { ATTENDANTS_KEY, type AttendantAvailability } from "@/hooks/team/useAttendants";

/**
 * Nota de contrato (#3876 F3): **não existe `member_user_ids` aqui**, e é
 * deliberado. "Quem atende esta fila" é pergunta de PESSOA e já tem dono —
 * `sector_ids` de cada atendente em `/api/v1/attendants/availability`, a mesma
 * leitura da aba Atendimento. Um segundo leitor da mesma pergunta divergiria na
 * primeira correção, e o GET dos setores continua com o contrato de antes desta
 * fatia (o próprio texto dele recusa devolver `member_user_ids`).
 */
export interface Sector {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  /** Quantos atendentes estão nesta fila agora. */
  member_count: number;
  /**
   * Cor de identificação da fila (`#rrggbb`, migration 9084) ou `null` = sem
   * cor, que é o visual de antes da fatia. A frente do chip sai de
   * `escolheAFrente` — nunca de escolha de quem pinta.
   */
  color: string | null;
  /**
   * Horário da fila. `{}` = 24/7 — janela existe para restringir, igual à
   * jornada do atendente (`AvailabilitySchedule`).
   */
  schedule: AvailabilitySchedule;
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
    mutationFn: async (input: {
      name: string;
      description: string | null;
      schedule?: AvailabilitySchedule;
    }) =>
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
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: {
        name?: string;
        description?: string | null;
        schedule?: AvailabilitySchedule;
        /** `#rrggbb` ou `null` (apagar a cor). Validado no Zod e no CHECK. */
        color?: string | null;
      };
    }) =>
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

/**
 * Define as FILAS de um atendente (manager+; a API enforça). A lista recebida
 * SUBSTITUI o conjunto — vazia = sem fila nenhuma.
 */
export function useAssignSector() {
  const t = useT();
  const qc = useQueryClient();
  const invalidar = useInvalidarSetores();
  return useMutation({
    mutationFn: async ({ userId, sectorIds }: { userId: string; sectorIds: string[] }) =>
      apiClient.put<{ data: { user_id: string; sector_ids: string[] } }>(
        `/api/v1/attendants/sector/${userId}`,
        { sector_ids: sectorIds },
      ),
    onError: (err) => showApiError(err),
    onSuccess: (res) => {
      toast.success(t("Setor do atendente atualizado."));
      // Grava já o conjunto que o PUT devolveu. A próxima ação sobre a mesma
      // pessoa monta a lista a partir do roster em cache; esperar o refetch da
      // invalidação deixaria uma janela em que ela parte da lista ANTIGA e
      // desfaz a ação anterior (#3879: a pessoa saía das duas filas).
      qc.setQueryData<{ data: AttendantAvailability[] }>(ATTENDANTS_KEY, (antigo) =>
        antigo
          ? {
              ...antigo,
              data: antigo.data.map((a) =>
                a.user_id === res.data.user_id ? { ...a, sector_ids: res.data.sector_ids } : a,
              ),
            }
          : antigo,
      );
      invalidar();
    },
  });
}
