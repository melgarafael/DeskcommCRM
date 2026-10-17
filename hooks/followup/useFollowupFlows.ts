"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

export type FollowupFlowStatus = "draft" | "active" | "disabled";

export interface FollowupFlowPointerRow {
  id: string;
  name: string;
  status: FollowupFlowStatus;
  active_version_id: string | null;
  handoff_policy: string;
  updated_at: string;
}

interface ListResponse {
  data: FollowupFlowPointerRow[];
}

interface SingleResponse {
  data: FollowupFlowPointerRow;
}

export const followupFlowsListQueryKey = ["followup", "flows", "list"] as const;

export function useFollowupFlows(opts?: {
  initialData?: FollowupFlowPointerRow[];
  /** Recorta a listagem por superfície (`atendimento` = tela de fluxos de atendimento). */
  surface?: FollowupFlowSurface;
  /** `false` = não busca (o Fim de um follow-up não precisa da lista de roteiros). */
  enabled?: boolean;
}) {
  const surface = opts?.surface;
  return useQuery({
    // A lista de follow-ups mantém a chave de sempre (instalar modelo e
    // duplicar escrevem nela); só o recorte por superfície ganha chave própria.
    queryKey: surface ? [...followupFlowsListQueryKey, surface] : followupFlowsListQueryKey,
    queryFn: async () => {
      try {
        const url = surface
          ? `/api/v1/ai/followup-flows?surface=${encodeURIComponent(surface)}`
          : "/api/v1/ai/followup-flows";
        const res = await apiClient.get<ListResponse>(url);
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
    enabled: opts?.enabled ?? true,
  });
}

export function useCreateFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "create"],
    mutationFn: async (input: { name: string; surface?: FollowupFlowSurface }) => {
      const res = await apiClient.post<SingleResponse>("/api/v1/ai/followup-flows", {
        name: input.name,
        ...(input.surface ? { surface: input.surface } : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      // Invalidate (não setQueryData): a lista agora é por superfície, e o hook
      // de criação não sabe qual recorte está na tela. Refetch resolve os dois.
      void qc.invalidateQueries({ queryKey: followupFlowsListQueryKey });
      toast.success(t("Fluxo criado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

export function useDuplicateFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "duplicate"],
    mutationFn: async (id: string) => {
      const res = await apiClient.post<SingleResponse>(`/api/v1/ai/followup-flows/${id}/duplicate`, {});
      return res.data;
    },
    onSuccess: (created) => {
      qc.setQueryData<FollowupFlowPointerRow[]>(followupFlowsListQueryKey, (prev) =>
        prev ? [created, ...prev] : [created],
      );
      toast.success(t("Fluxo duplicado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

// ─── Exportar / importar (lib/followup/portabilidade.ts) ────────────────────

interface ExportResponse {
  data: { file_name: string; file: unknown };
}

/** Baixa o fluxo como arquivo `.fluxo.json`. Sem estado de cache: é uma leitura pontual. */
export function useExportFollowupFlow() {
  const t = useT();
  return useMutation({
    mutationKey: ["followup", "flows", "export"],
    mutationFn: async (id: string) => {
      const res = await apiClient.get<ExportResponse>(`/api/v1/ai/followup-flows/${id}/export`);
      return res.data;
    },
    onSuccess: ({ file_name, file }) => {
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("Fluxo exportado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

export interface PendenciaDaImportacao {
  codigo: string;
  bloqueia: boolean;
  no?: { id: string; label: string };
  referencia?: string;
}

interface ImportResponse {
  data: { flow: FollowupFlowPointerRow; pendencias: PendenciaDaImportacao[] };
}

/**
 * Importa um arquivo exportado. Erro não vira toast aqui: o diálogo mostra a
 * lista de problemas do arquivo (`details.problemas`) onde a pessoa está olhando.
 */
export function useImportFollowupFlow() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "import"],
    mutationFn: async (input: { file: unknown; name?: string }) => {
      const res = await apiClient.post<ImportResponse>("/api/v1/ai/followup-flows/import", {
        file: input.file,
        ...(input.name ? { name: input.name } : {}),
      });
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: followupFlowsListQueryKey });
      toast.success(t("Fluxo importado como rascunho."));
    },
  });
}
