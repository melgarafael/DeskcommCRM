"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { fundeRespostaNoCard } from "@/lib/kanban/owner";
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
      ? {
          ...atual,
          leads: atual.leads.map((l) => (l.id === leadId ? fundeRespostaNoCard(l, lead) : l)),
        }
      : atual,
  );
}

interface WinArgs {
  leadId: string;
  /**
   * O motivo do ganho (issue #5181) — o que a caixa do card coletou antes de
   * fechar. Ausente/`""` mantém o corpo `{}` de antes: o servidor decide
   * (lista do funil, `won_reason_required`), e é ele quem recusa.
   */
  wonReason?: string;
}
interface LoseArgs {
  leadId: string;
  lostReason: string;
}

interface OpcoesDoGanho {
  /**
   * A recusa `won_reason_invalid` do servidor (motivo fora de
   * `settings.won_reasons`) vira mensagem NA PRÓPRIA CAIXA, não toast: a pessoa
   * acabou de escolher na lista, e o único conserto possível é escolher outra —
   * um toast genérico ("deu errado") some justamente quando ela precisa reler
   * a lista. Sem esta opção, cai no `showApiError` de sempre.
   */
  onMotivoRecusado?: (erro: ApiError) => void;
}

export function useWinLead(pipelineId: string, opcoes: OpcoesDoGanho = {}) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;
  return useMutation({
    mutationFn: async ({ leadId, wonReason }: WinArgs) => {
      marcarEcoLocal(leadId);
      // Corpo EXATAMENTE o de antes quando não há motivo: `won_reason: ""` não é
      // o mesmo que "não informei" para quem lê o corpo no servidor.
      return apiClient.post<{ data: Lead }>(
        `/api/v1/leads/${leadId}/win`,
        wonReason ? { won_reason: wonReason } : {},
      );
    },
    onSuccess: (res, { leadId }) => {
      gravaLeadNoQuadro(qc, queryKey, leadId, res?.data);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "won_reason_invalid" && opcoes.onMotivoRecusado) {
        opcoes.onMotivoRecusado(err);
        return;
      }
      showApiError(err);
    },
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

interface MoveToPipelineArgs {
  leadId: string;
  targetPipelineId: string;
  /**
   * A etapa de ENTRADA no funil destino (issue #3643). Ausente ou `null` é o
   * comportamento de sempre: o servidor escolhe a primeira etapa aberta
   * (`escolheEtapaDeDestino`). Não vai como `null` no corpo porque o schema
   * aceita `stage_id` só como uuid — e porque "não escolhi" não é um pedido.
   */
  targetStageId?: string | null;
}

/**
 * Levar o negócio para OUTRO funil — `POST /api/v1/leads/[id]/clone`.
 *
 * A origem (ESTE quadro) fecha como perdida com o motivo canônico
 * `moved_to_another_pipeline` (o servidor grava sozinho quando nenhum motivo é
 * enviado — `lib/leads/motivo-da-perda.ts`); é `res.data.origem`, não
 * `res.data.lead` (o clone novo, que vive no funil de DESTINO e não pertence a
 * este cache), que volta para o quadro atual — mesmo padrão de
 * `gravaLeadNoQuadro` que `useLoseLead` já usa, então o card sai visualmente
 * para a etapa de perda deste funil, com o motivo na linha do tempo.
 */
export function useMoveLeadToPipeline(pipelineId: string) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;
  return useMutation({
    mutationFn: async ({ leadId, targetPipelineId, targetStageId }: MoveToPipelineArgs) => {
      marcarEcoLocal(leadId);
      return apiClient.post<{ data: { lead: Lead; origem: Lead } }>(
        `/api/v1/leads/${leadId}/clone`,
        {
          pipeline_id: targetPipelineId,
          // Sem escolha, o corpo é EXATAMENTE o de antes: quem decide a etapa
          // continua sendo o servidor.
          ...(targetStageId ? { stage_id: targetStageId } : {}),
        },
      );
    },
    onSuccess: (res, { leadId }) => {
      gravaLeadNoQuadro(qc, queryKey, leadId, res?.data?.origem);
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
