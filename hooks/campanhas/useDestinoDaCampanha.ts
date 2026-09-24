"use client";
/**
 * As listas que a campanha precisa para dizer ONDE o card nasce e QUEM atende:
 * funis, etapas do funil escolhido, e agentes publicados.
 *
 * Fica junto das campanhas e não em `hooks/pipelines/` porque lá não há leitura:
 * o Kanban carrega funis pelo Server Component, de propósito (a tela é aberta a
 * qualquer papel e a rota exige `manager`). A campanha é manager+ por inteiro,
 * então pode ler pela API sem esse cuidado.
 */
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface FunilDaCampanha {
  id: string;
  name: string;
  is_default: boolean;
  channel_session_id?: string | null;
}

export interface EtapaDoFunil {
  id: string;
  name: string;
  position: number | null;
  is_won: boolean;
  is_lost: boolean;
}

export interface AgenteDisponivel {
  id: string;
  name: string;
  published_version_id?: string | null;
  archived_at?: string | null;
}

export function useFunis() {
  return useQuery({
    queryKey: ["campanhas-funis"],
    queryFn: async () => (await apiClient.get<{ data: FunilDaCampanha[] }>("/api/v1/pipelines")).data,
    staleTime: 60_000,
  });
}

export function useEtapas(pipelineId: string | null) {
  return useQuery({
    queryKey: ["campanhas-etapas", pipelineId],
    queryFn: async () =>
      (await apiClient.get<{ data: EtapaDoFunil[] }>(`/api/v1/pipelines/${pipelineId}/stages`)).data,
    // Sem funil escolhido não há etapa possível — e pedir `/pipelines/null/stages`
    // seria um 404 por construção.
    enabled: !!pipelineId,
    staleTime: 60_000,
  });
}

export function useAgentesPublicados() {
  return useQuery({
    queryKey: ["campanhas-agentes"],
    queryFn: async () => {
      const r = await apiClient.get<{ data: AgenteDisponivel[] }>("/api/v1/ai/agents");
      // Só agente PUBLICADO pode atender: um rascunho escolhido aqui viraria
      // silêncio na conversa, e o operador não teria como saber por quê.
      return (r.data ?? []).filter((a) => !!a.published_version_id && !a.archived_at);
    },
    staleTime: 60_000,
  });
}
