"use client";
/**
 * As consultas e as ações da tela de Campanhas.
 *
 * Uma campanha `running` muda sozinha (o cron envia de minuto em minuto), então
 * a tela de detalhe RECONSULTA enquanto ela anda e para quando ela para — polling
 * eterno numa campanha concluída é bateria e banco gastos para ver o mesmo número.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ContagemDaCampanha, TaxasDaCampanha } from "@/lib/campanhas/metricas";
import type { StatusDaCampanha } from "@/lib/campanhas/tipos";

export interface CampanhaDaLista {
  id: string;
  name: string;
  status: StatusDaCampanha;
  channel_session_id: string;
  snapshot_total: number;
  snapshot_eligible: number;
  snapshot_excluded: number;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface CampanhaDetalhada extends CampanhaDaLista {
  /** Números EXTRAS do rodízio (migration 0377). O principal é channel_session_id. */
  channel_session_ids?: string[];
  /** Destino do card e quem atende (migration 0378). `null` = a regra do número. */
  pipeline_id?: string | null;
  stage_id?: string | null;
  agent_id?: string | null;
  description: string | null;
  message_body: string | null;
  base_legal: string;
  lia_ref: string | null;
  audience_filter: Record<string, unknown>;
  content_version: number;
  prepared_at: string | null;
  paused_at: string | null;
  failure_code: string | null;
  intervalo_segundos: number | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  teto_diario: number | null;
  teto_horario: number | null;
}

export interface Destinatario {
  id: string;
  contact_id: string;
  /** Por qual número esta pessoa foi falada. `null` = ainda não saiu. */
  channel_session_id: string | null;
  status: string;
  eligibility_status: string;
  exclusion_reason: string | null;
  legenda_da_exclusao: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  contacts: { name: string | null; display_name: string | null } | null;
}

export interface Metricas {
  contagem: ContagemDaCampanha;
  taxas: TaxasDaCampanha;
  progresso: number;
  parcial: boolean;
}

export interface PreviaDaAudiencia {
  total: number;
  elegiveis: number;
  excluidos: number;
  motivos: Record<string, number>;
  amostra: Array<{ nome: string | null; motivo: string | null }>;
  legenda: Record<string, string>;
}

/** Campanha que ainda vai mudar sozinha — é quem justifica reconsultar. */
const EM_MOVIMENTO: ReadonlySet<StatusDaCampanha> = new Set([
  "preparing",
  "running",
  "scheduled",
]);

export function useCampanhas(filtros: { status?: string; limit?: number }) {
  return useInfiniteQuery({
    queryKey: ["campanhas", filtros],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filtros.status) qs.set("status", filtros.status);
      qs.set("limit", String(filtros.limit ?? 30));
      if (pageParam) qs.set("cursor", pageParam);
      try {
        return await apiClient.get<{ data: CampanhaDaLista[]; meta?: { cursor?: string; has_more?: boolean } }>(
          `/api/v1/campaigns?${qs.toString()}`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (ultima) => (ultima.meta?.has_more ? ultima.meta.cursor : undefined),
  });
}

export function useCampanha(id: string) {
  return useQuery({
    queryKey: ["campanha", id],
    queryFn: async () => (await apiClient.get<{ data: CampanhaDetalhada }>(`/api/v1/campaigns/${id}`)).data,
    refetchInterval: (q) => (q.state.data && EM_MOVIMENTO.has(q.state.data.status) ? 10_000 : false),
  });
}

export function useMetricasDaCampanha(id: string, status?: StatusDaCampanha) {
  return useQuery({
    queryKey: ["campanha-metricas", id],
    queryFn: async () =>
      (await apiClient.get<{ data: Metricas }>(`/api/v1/campaigns/${id}/metrics`)).data,
    refetchInterval: status && EM_MOVIMENTO.has(status) ? 10_000 : false,
  });
}

export function useDestinatarios(id: string, filtros: { status?: string }) {
  return useInfiniteQuery({
    queryKey: ["campanha-destinatarios", id, filtros],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filtros.status) qs.set("status", filtros.status);
      qs.set("limit", "50");
      if (pageParam) qs.set("cursor", pageParam);
      return await apiClient.get<{
        data: Destinatario[];
        meta?: { cursor?: string; has_more?: boolean };
      }>(`/api/v1/campaigns/${id}/recipients?${qs.toString()}`);
    },
    getNextPageParam: (ultima) => (ultima.meta?.has_more ? ultima.meta.cursor : undefined),
  });
}

export type AcaoDeCampanha =
  | "preparar"
  | "iniciar"
  | "agendar"
  | "pausar"
  | "retomar"
  | "cancelar"
  | "duplicar"
  | "testar";

export function useAcaoDeCampanha(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entrada: { acao: AcaoDeCampanha; corpo?: Record<string, unknown> }) =>
      await apiClient.post<{ data: Record<string, unknown> }>(
        `/api/v1/campaigns/${id}/${entrada.acao}`,
        entrada.corpo ?? {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["campanha", id] });
      void qc.invalidateQueries({ queryKey: ["campanha-metricas", id] });
      void qc.invalidateQueries({ queryKey: ["campanha-destinatarios", id] });
      void qc.invalidateQueries({ queryKey: ["campanhas"] });
    },
    onError: (err) => showApiError(err),
  });
}

export function usePreviaDaAudiencia() {
  return useMutation({
    mutationFn: async (corpo: {
      audience_filter: Record<string, unknown>;
      message_body: string;
      campaign_id?: string;
    }) => (await apiClient.post<{ data: PreviaDaAudiencia }>("/api/v1/campaigns/preview", corpo)).data,
    onError: (err) => showApiError(err),
  });
}

export function useCriarCampanha() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (corpo: Record<string, unknown>) =>
      (await apiClient.post<{ data: CampanhaDaLista }>("/api/v1/campaigns", corpo)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["campanhas"] }),
    onError: (err) => showApiError(err),
  });
}

export function useEditarCampanha(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (corpo: Record<string, unknown>) =>
      (await apiClient.patch<{ data: CampanhaDetalhada }>(`/api/v1/campaigns/${id}`, corpo)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["campanha", id] });
      void qc.invalidateQueries({ queryKey: ["campanhas"] });
    },
    onError: (err) => showApiError(err),
  });
}
