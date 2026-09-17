"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";
import type { BoardData } from "@/lib/kanban/types";

interface MoveArgs {
  leadId: string;
  stageId: string;
  positionInStage: number;
  expectedUpdatedAt: string;
}

export function useMoveCard(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;

  return useMutation({
    mutationFn: async (args: MoveArgs) => {
      // Minha própria ação não pulsa: o card já se moveu sob o cursor.
      marcarEcoLocal(args.leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${args.leadId}/move`, {
        stage_id: args.stageId,
        position_in_stage: args.positionInStage,
        expected_updated_at: args.expectedUpdatedAt,
      });
    },
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey });
      const snapshot = qc.getQueryData<BoardData>(queryKey);
      if (snapshot) {
        qc.setQueryData<BoardData>(queryKey, {
          ...snapshot,
          leads: snapshot.leads.map((l) =>
            l.id === args.leadId
              ? { ...l, stage_id: args.stageId, position_in_stage: args.positionInStage }
              : l,
          ),
        });
      }
      return { snapshot };
    },
    onSuccess: (res, args) => {
      // A resposta é o lead como o servidor o deixou, com o `updated_at` final.
      // Sem gravá-la aqui, o cache seguia com o valor de antes até o refetch do
      // `onSettled` chegar, e arrastar o mesmo card de novo nesse intervalo
      // mandava `expected_updated_at` velho → 409 (issue #916).
      qc.setQueryData<BoardData>(queryKey, (atual) =>
        atual
          ? {
              ...atual,
              leads: atual.leads.map((l) => (l.id === args.leadId ? { ...l, ...res.data } : l)),
            }
          : atual,
      );
    },
    onError: (err, _args, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKey, ctx.snapshot);
      if (err instanceof ApiError && err.status === 409) {
        // Reconcile authoritative state — server already gave new updated_at.
        qc.invalidateQueries({ queryKey });
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      // A marca fecha com a AÇÃO, não com o relógio: daqui em diante só a folga
      // curta do último evento da cascata (ver lib/kanban/local-echo.ts).
      liberarEcoLocal(args.leadId);
      qc.invalidateQueries({ queryKey });
    },
  });
}
