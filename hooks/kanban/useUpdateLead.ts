"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";
import type { BoardData } from "@/lib/kanban/types";
import type { UpdateLeadInput } from "@/lib/schemas/leads";

/**
 * O CARIMBO DA RESPOSTA VOLTA PARA O CACHE (issue #916).
 *
 * As três mutações desta família — ganhar, perder e editar — recebiam o lead
 * atualizado na resposta e o jogavam fora: só `invalidateQueries` no
 * `onSettled`. Entre a resposta e o refetch chegar, o card no cache de
 * `["board", pipelineId]` continua com o `updated_at` de antes — e é DESSE
 * cache que `components/kanban/KanbanBoard.tsx` tira o `expected_updated_at` do
 * arrasto. Editar o negócio no dossiê e arrastá-lo em seguida dava 409, pelo
 * mesmo mecanismo que o arrasto repetido já dava (e que `useMoveCard` corrigiu).
 *
 * A fusão é ampla (`{ ...card, ...lead }`) pelo mesmo motivo de lá: a resposta
 * traz `status` e `closed_at`, escritos pelo gatilho `fn_crm_lead_close_on_stage`,
 * que o card precisa para parar de aparecer como negócio aberto.
 */
function gravaLeadNoQuadro(
  qc: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  leadId: string,
  lead: Lead | undefined,
): void {
  if (!lead) return;
  qc.setQueryData<BoardData>(queryKey, (atual) =>
    atual
      ? { ...atual, leads: atual.leads.map((l) => (l.id === leadId ? { ...l, ...lead } : l)) }
      : atual,
  );
}

interface WinArgs {
  leadId: string;
}
interface LoseArgs {
  leadId: string;
  lostReason: string;
}

export function useWinLead(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;
  return useMutation({
    mutationFn: async ({ leadId }: WinArgs) => {
      marcarEcoLocal(leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${leadId}/win`, {});
    },
    onSuccess: (res, { leadId }) => {
      gravaLeadNoQuadro(qc, queryKey, leadId, res?.data);
    },
    onError: showApiError,
    onSettled: (_data, _err, { leadId }) => {
      liberarEcoLocal(leadId);
      qc.invalidateQueries({ queryKey });
    },
  });
}

export function useLoseLead(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;
  return useMutation({
    mutationFn: async ({ leadId, lostReason }: LoseArgs) => {
      marcarEcoLocal(leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${leadId}/lose`, {
        lost_reason: lostReason,
      });
    },
    onSuccess: (res, { leadId }) => {
      gravaLeadNoQuadro(qc, queryKey, leadId, res?.data);
    },
    onError: showApiError,
    onSettled: (_data, _err, { leadId }) => {
      liberarEcoLocal(leadId);
      qc.invalidateQueries({ queryKey });
    },
  });
}

interface EditArgs {
  leadId: string;
  patch: UpdateLeadInput;
}

export function useEditLead(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;
  return useMutation({
    mutationFn: async ({ leadId, patch }: EditArgs) => {
      // Minha própria ação não pulsa: o feedback dela já é a mudança na tela.
      marcarEcoLocal(leadId);
      return apiClient.patch<{ data: Lead }>(`/api/v1/leads/${leadId}`, patch);
    },
    onSuccess: (res, { leadId }) => {
      gravaLeadNoQuadro(qc, queryKey, leadId, res?.data);
    },
    onError: showApiError,
    onSettled: (_data, _err, { leadId }) => {
      liberarEcoLocal(leadId);
      qc.invalidateQueries({ queryKey });
    },
  });
}
