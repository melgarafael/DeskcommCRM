"use client";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

/**
 * Os estados que `followup_enrollments.status` aceita — todos eles.
 *
 * É o ÚNICO union do TypeScript que enumera o conjunto inteiro: o
 * `EnrollmentStatus` do motor (`lib/followup/node-handlers.ts`) lista o que o
 * motor manipula, e o motor nunca escreve nem lê `paused_manual` (o claim filtra
 * `active|waiting_reply`). Por isso este é o par do banco em
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`: status novo no
 * CHECK sem entrada aqui reprova o CI, em vez de virar uma linha na fila com
 * rótulo cru.
 */
export type FollowupEnrollmentStatus =
  | "active"
  | "waiting_reply"
  | "dormente"
  | "paused_handoff"
  | "paused_manual"
  // Roteiro de atendimento em andamento (0394): conduzido pelo turno do agente,
  // não pelo relógio. O motor de follow-up nunca o lê.
  | "coletando"
  | "completed"
  | "cancelled"
  | "dead";

export interface FollowupQueueRow {
  source: "enrollment" | "promise";
  id: string;
  contact: { id: string; name: string };
  flow_name: string | null;
  agent_name: string | null;
  node_or_reason: string;
  next_fire_at: string | null;
  status: string;
  detail: string | null;
}

export interface FollowupQueueFilters {
  status?: FollowupEnrollmentStatus;
  pointer_id?: string;
  q?: string;
}

interface ListResponse {
  data: FollowupQueueRow[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

const QUEUE_LIMIT = 20;

export const followupQueueQueryKey = (filters: FollowupQueueFilters) =>
  ["followup", "queue", filters] as const;

export function useFollowupQueue(filters: FollowupQueueFilters = {}) {
  return useInfiniteQuery({
    queryKey: followupQueueQueryKey(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.status) qs.set("status", filters.status);
      if (filters.pointer_id) qs.set("pointer_id", filters.pointer_id);
      if (filters.q) qs.set("q", filters.q);
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", String(QUEUE_LIMIT));
      try {
        return await apiClient.get<ListResponse>(`/api/v1/ai/followups/queue?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) => (last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined),
    staleTime: 15_000,
  });
}

export function useCancelFollowupEnrollment() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "enrollments", "cancel"],
    mutationFn: async (enrollmentId: string) => {
      const res = await apiClient.post<{ data: { id: string; status: string } }>(
        `/api/v1/ai/followups/enrollments/${enrollmentId}/cancel`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
      toast.success(t("Follow-up cancelado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

/**
 * Desmarcar a PROMESSA — o retorno avulso que o agente combinou.
 *
 * Mutação separada da de enrollment porque são duas coisas diferentes no banco
 * e no significado: uma encerra a caminhada num fluxo publicado, a outra desfaz
 * uma promessa que o agente fez numa conversa. A fila mostra as duas juntas
 * (é o que o operador quer ver), mas unificar o comando faria um cancelamento
 * atingir a linha errada em silêncio.
 */
export function useCancelFollowupPromise() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "promises", "cancel"],
    mutationFn: async (promiseId: string) => {
      const res = await apiClient.post<{ data: { id: string; status: string } }>(
        `/api/v1/ai/followups/promises/${promiseId}/cancel`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
      toast.success(t("Retorno cancelado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}
