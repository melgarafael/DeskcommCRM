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
  /**
   * Os campos que o diálogo de campos obrigatórios coletou (issue #1536) —
   * viajam NA MESMA escrita que muda a etapa, nunca num PATCH anterior.
   */
  customFields?: Record<string, unknown>;
  /** O motivo do ganho coletado pelo mesmo diálogo, quando o destino fecha. */
  wonReason?: string;
}

/** O que a recusa `required_fields_missing` devolve para a tela abrir o diálogo. */
export interface RecusaDeCampos {
  /** Os argumentos originais do move — o diálogo só acrescenta o que coletou. */
  args: MoveArgs;
  faltando: { chave: string; rotulo: string; tipo?: string; opcoes?: { value: string; label: string }[] }[];
}

interface OpcoesDeMove {
  /**
   * A recusa de campos obrigatórios vira DIÁLOGO, não toast (issue #1536):
   * toast diz "deu errado" sem o que fazer; o diálogo pede só o que falta e
   * reenvia o MESMO move. Quem não passa esta opção (outros consumidores do
   * hook) cai no `showApiError` de sempre.
   */
  onCamposFaltando?: (recusa: RecusaDeCampos) => void;
}

export function useMoveCard(pipelineId: string, opcoes: OpcoesDeMove = {}) {
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
        ...(args.customFields ? { custom_fields: args.customFields } : {}),
        ...(args.wonReason !== undefined ? { won_reason: args.wonReason } : {}),
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
    onError: (err, args, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKey, ctx.snapshot);
      if (err instanceof ApiError && err.status === 409) {
        // Reconcile authoritative state — server already gave new updated_at.
        qc.invalidateQueries({ queryKey });
      }
      // O DIAGNÓGOSTO em vez do toast (issue #1536): a recusa traz em
      // `details.faltando` chave e rótulo de cada campo — é a tela que sabe
      // transformar isso em formulário, então quem move é quem decide como
      // perguntar. O rollback acima já devolveu o card; o reenvio parte do
      // MESMO `expected_updated_at`, porque a recusa veio antes de qualquer
      // escrita — não há segundo carimbo para recolher.
      const faltando = (err instanceof ApiError ? err.details?.faltando : undefined) as
        | RecusaDeCampos["faltando"]
        | undefined;
      if (err instanceof ApiError && err.status === 422 && Array.isArray(faltando) && faltando.length > 0) {
        if (opcoes.onCamposFaltando) {
          opcoes.onCamposFaltando({ args, faltando });
          return;
        }
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
