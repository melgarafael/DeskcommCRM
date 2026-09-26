"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

import { chaveDoFunil } from "./useAgentMapping";

/**
 * Criar, editar e arquivar etapa do funil — a escrita da tela de etapas.
 *
 * ⚠️ NÃO HÁ QUERY AQUI, E É DELIBERADO. A leitura é a MESMA de
 * `useAgentMapping`: o GET de `agent-mapping` já devolve as etapas ativas na
 * ordem do funil COM o passo do assistente de cada uma (`agent_stage_hint`
 * invertido em `mapeamento`), que é justamente o que esta tela precisa para
 * explicar por que uma marcação não sai. O corpo das rotas de etapa devolve o
 * funil sem o passo do assistente — montar a lista com ele daria duas réguas
 * para o mesmo quadro, e a segunda não saberia dizer que «Pago» representa
 * «Ganho». Uma leitura só, uma chave de cache só.
 *
 * ⚠️ DEPOIS DE QUALQUER RESPOSTA — sucesso OU erro —, RELÊ. Não há concorrência
 * otimista nestas rotas: duas abas editando o mesmo funil terminam em "o último
 * ganha", e o 409 diz literalmente "recarregue a página". Reaproveitar o corpo
 * da resposta como cache economizaria um GET e traria o problema de volta pela
 * porta dos fundos (o corpo não tem o passo do assistente); reler é o preço
 * honesto numa tela de configuração ocasional.
 */

const rota = (pipelineId: string) =>
  `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/stages`;

const daEtapa = (pipelineId: string, stageId: string) =>
  `${rota(pipelineId)}/${encodeURIComponent(stageId)}`;

/** O que o PATCH aceita. `depois_de` é o vizinho da ESQUERDA (`null` = primeira coluna). */
export interface PatchDeEtapa {
  name?: string;
  is_won?: boolean;
  is_lost?: boolean;
  depois_de?: string | null;
  /**
   * Probabilidade de ganho da etapa, 0–100. `null` limpa a calibração — e a
   * previsão volta a reportar a etapa no balde "sem probabilidade".
   */
  win_probability?: number | null;
}

function useReler(pipelineId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: chaveDoFunil(pipelineId) });
  };
}

export function useCriarEtapa(pipelineId: string) {
  const reler = useReler(pipelineId);
  return useMutation({
    mutationFn: (name: string) => apiClient.post<unknown>(rota(pipelineId), { name }),
    onSettled: reler,
  });
}

export function useEditarEtapa(pipelineId: string) {
  const reler = useReler(pipelineId);
  return useMutation({
    mutationFn: ({ stageId, patch }: { stageId: string; patch: PatchDeEtapa }) =>
      apiClient.patch<unknown>(daEtapa(pipelineId, stageId), patch),
    onSettled: reler,
  });
}

export function useArquivarEtapa(pipelineId: string) {
  const reler = useReler(pipelineId);
  return useMutation({
    // Sem destino é uma pergunta legítima, não um pedido pela metade: a rota
    // responde 422 com a CONTAGEM de negócios da etapa, que é o número que a
    // tela precisa para perguntar "para onde eles vão?". Etapa vazia arquiva
    // direto — não há nada para onde mandar.
    mutationFn: ({ stageId, destinoId }: { stageId: string; destinoId: string | null }) =>
      apiClient.delete<unknown>(
        destinoId
          ? `${daEtapa(pipelineId, stageId)}?destino=${encodeURIComponent(destinoId)}`
          : daEtapa(pipelineId, stageId),
      ),
    onSettled: reler,
  });
}
