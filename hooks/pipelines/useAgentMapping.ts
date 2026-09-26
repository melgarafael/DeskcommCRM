"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { LeadStage } from "@/lib/agent-engine/agent/lead-state";
import { apiClient } from "@/lib/api/client";

/**
 * Leitura e escrita do mapeamento passo-do-agente → etapa-do-funil.
 *
 * ⚠️ DEPOIS DE QUALQUER ERRO, RELÊ. Não há concorrência otimista nesta rota: duas
 * abas editando o mesmo funil terminam em "o último ganha", e o 409 diz
 * literalmente "recarregue a página". Se a tela deixasse o usuário reenviar sem
 * reler, ele estaria mandando um mapa construído sobre um funil que não existe
 * mais — e o segundo envio poderia até passar, gravando por cima de uma decisão
 * que outra pessoa acabou de tomar.
 *
 * O sucesso também substitui o cache pela RESPOSTA DO SERVIDOR (que é uma
 * releitura, não o eco do pedido): se um update parcial deixou o funil diferente
 * do mapa enviado, a tela mostra o que o banco tem.
 */

export interface EtapaDoFunil {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
  /**
   * Probabilidade de ganho da etapa, 0–100 (migration 0426). `null` = etapa
   * sem calibração. `undefined` em leituras antigas em cache.
   */
  win_probability?: number | null;
  /** Quem mexeu nesta etapa por último (migration 0101). `null` antes dela. */
  last_change_actor_kind?: string | null;
  last_change_at?: string | null;
}

/** Os sete passos sempre presentes; `null` = "não mover o card". */
export type MapaDoAgente = Record<LeadStage, string | null>;

export interface EstadoDoMapeamento {
  etapas: EtapaDoFunil[];
  mapeamento: MapaDoAgente;
}

/**
 * A chave desta leitura, exportada porque a tela de ETAPAS escreve sobre o mesmo
 * funil e precisa invalidá-la (`useStages`). Duas literais `["agent-mapping",
 * id]` em arquivos diferentes divergiriam no primeiro ajuste, e o sintoma seria
 * a lista de etapas velha depois de uma edição bem-sucedida.
 */
export const chaveDoFunil = (pipelineId: string) => ["agent-mapping", pipelineId];
const chave = chaveDoFunil;
const rota = (pipelineId: string) =>
  `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/agent-mapping`;

export function useAgentMapping(pipelineId: string) {
  return useQuery({
    queryKey: chave(pipelineId),
    queryFn: () =>
      apiClient.get<{ data: EstadoDoMapeamento }>(rota(pipelineId)).then((r) => r.data),
  });
}

export function useSaveAgentMapping(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    // O PUT é TOTAL: os sete passos, com `null` explícito para "não mover".
    // Corpo parcial é 422 na rota — mandar delta daqui seria erro garantido.
    mutationFn: (mapeamento: MapaDoAgente) =>
      apiClient
        .put<{ data: EstadoDoMapeamento }>(rota(pipelineId), { mapeamento })
        .then((r) => r.data),
    onSuccess: (estado) => qc.setQueryData(chave(pipelineId), estado),
    onError: () => {
      void qc.invalidateQueries({ queryKey: chave(pipelineId) });
    },
  });
}
