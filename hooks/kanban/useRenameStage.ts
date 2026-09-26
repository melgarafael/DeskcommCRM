"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { chaveDoQuadro } from "./useBoard";
import type { BoardData } from "@/lib/kanban/types";

interface RenameArgs {
  stageId: string;
  name: string;
}

/**
 * Renomear a etapa direto do cabeçalho da coluna, no board — mesma rota
 * (`PATCH /api/v1/pipelines/:id/stages/:stageId`) que a tela de
 * Configurações › Funis já usa (`_stages.tsx`), aqui só com outro cliente.
 *
 * Otimista + invalidação, como `useMoveCard`: a coluna mostra o nome novo na
 * hora, e o `onSettled` reconcilia com o servidor (inclusive a recusa por
 * nome duplicado, que só o backend conhece).
 */
export function useRenameStage(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = chaveDoQuadro(pipelineId);

  return useMutation({
    mutationFn: ({ stageId, name }: RenameArgs) =>
      apiClient.patch(`/api/v1/pipelines/${pipelineId}/stages/${stageId}`, { name }),
    onMutate: async ({ stageId, name }) => {
      await qc.cancelQueries({ queryKey });
      const snapshot = qc.getQueryData<BoardData>(queryKey);
      if (snapshot) {
        qc.setQueryData<BoardData>(queryKey, {
          ...snapshot,
          stages: snapshot.stages.map((s) => (s.id === stageId ? { ...s, name } : s)),
        });
      }
      return { snapshot };
    },
    onError: (err, _args, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKey, ctx.snapshot);
      showApiError(err);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey });
    },
  });
}
