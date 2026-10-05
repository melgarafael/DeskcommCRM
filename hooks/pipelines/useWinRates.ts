"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { TaxaDaEtapa } from "@/lib/metrics/taxa-da-etapa";

/**
 * Uma etapa medida na ETAPA ATUAL (#2032): quem está NELA AGORA, ancorado em
 * `crm_leads.stage_changed_at` (com `created_at` de reserva) e nunca em
 * `last_activity_at` — que é tempo sem resposta, outra pergunta.
 */
export interface LinhaDeTempoNaEtapa {
  etapa_id: string;
  quantidade: number;
  /** Média de horas na etapa; `null` só se a etapa não tiver ninguém. */
  horas_media: number | null;
  /** Mediana de horas — a média puxada por um preso há meses não a substitui. */
  horas_mediana: number | null;
  /** Amostra à vista: quantos medem por carimbo e quantos por reserva. */
  com_carimbo: number;
  sem_carimbo: number;
}

/**
 * O bloco da #2032. É OUTRA população da `taxas` — aquela mede quem passou
 * pela etapa na janela, este mede quem está nela agora (fora da janela) — e o
 * payload diz isso em `medida`/`base` para ninguém somar as duas.
 *
 * Opcional no TIPO de propósito: a chave pode receber o corpo de uma leitura em
 * cache anterior a este PR, e «sem o bloco» tem de ser legível, não erro de
 * compilação de quem lê.
 */
export interface BlocoDeTempoNaEtapa {
  medida: "etapa atual";
  ancora: string;
  base: string;
  amostra: number;
  limite: number;
  truncado: boolean;
  etapas: LinhaDeTempoNaEtapa[];
}

/**
 * A taxa histórica de ganho de cada etapa (issue #1753) — a contagem que a tela
 * de etapas mostra AO LADO do campo de probabilidade.
 *
 * ⚠️ É UMA LEITURA SEPARADA, com chave própria, e não entra no
 * `useAgentMapping`. Os dois mudam por motivos diferentes: o funil muda quando
 * alguém edita uma etapa, a taxa muda quando um negócio é movido. Colar as duas
 * na mesma chave faria a tela de etapas recarregar a cada card arrastado no
 * kanban — e o contrário, invalidar a taxa a cada rename, buscaria 10 mil
 * atividades por nada.
 *
 * ⚠️ A RESPOSTA NÃO É CONFIÁVEL POR FORMATO. `apiClient.get` devolve o corpo
 * que a rota mandou, e quem lê confere `Array.isArray(taxas)` antes de usá-lo:
 * uma leitura em cache de outra rota (ou o corpo de erro de um proxy) parado
 * nesta chave não pode virar «sem dados» na tela do gestor. O bloco
 * `tempo_na_etapa` (#2032) é opcional pelo MESMO motivo: corpo de antes deste
 * PR não tem ele, e «sem o bloco» tem de ser legível.
 */
export interface RespostaDasTaxas {
  inicio: string;
  fim: string;
  dias: number;
  /** A leitura bateu o teto: o número é AMOSTRA do período, não o período. */
  truncado: boolean;
  minimo_de_casos: number;
  taxas: TaxaDaEtapa[];
  tempo_na_etapa?: BlocoDeTempoNaEtapa;
}

export const chaveDasTaxas = (pipelineId: string) => ["stage-win-rates", pipelineId];

const rota = (pipelineId: string) =>
  `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/stages/win-rates`;

export function useTaxasDasEtapas(pipelineId: string) {
  return useQuery({
    queryKey: chaveDasTaxas(pipelineId),
    queryFn: () => apiClient.get<{ data: RespostaDasTaxas }>(rota(pipelineId)).then((r) => r.data),
  });
}
