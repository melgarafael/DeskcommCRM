"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import {
  followupFlowsListQueryKey,
  type FollowupFlowPointerRow,
} from "@/hooks/followup/useFollowupFlows";

/**
 * Instala um modelo pronto do catálogo como fluxo rascunho da organização.
 *
 * ⚠️ SEM `showApiError` AQUI, ao contrário dos irmãos deste arquivo. O erro
 * desta chamada tem endereço: «escolha a etapa», «você já tem um fluxo com esse
 * nome». Um toast que some em 4 s manda a pessoa clicar de novo; quem chama
 * mostra a mensagem DENTRO do diálogo, ao lado do botão que falhou.
 */
export interface InstalacaoDeModelo {
  model_id: string;
  stage_id?: string;
  name?: string;
}

export function useInstalarModelo() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "flows", "from-model"],
    mutationFn: async (entrada: InstalacaoDeModelo) => {
      const res = await apiClient.post<{ data: FollowupFlowPointerRow }>(
        "/api/v1/ai/followup-flows/from-model",
        entrada,
      );
      return res.data;
    },
    onSuccess: (criado) => {
      qc.setQueryData<FollowupFlowPointerRow[]>(followupFlowsListQueryKey, (prev) =>
        prev ? [criado, ...prev] : [criado],
      );
      // A linha devolvida não traz `trigger_kind`: reler devolve o gatilho à busca (#4593).
      void qc.invalidateQueries({ queryKey: followupFlowsListQueryKey });
    },
  });
}
