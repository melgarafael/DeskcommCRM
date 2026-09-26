"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import type { Previsao } from "@/lib/leads/previsao";

/** A previsão de um funil, com o id do funil que a originou. */
export type PrevisaoDoFunil = Previsao & { pipeline_id: string };

/**
 * A previsão ponderada do funil padrão da organização (issue #1535) — é o que
 * o painel "Previsão" de `/app/metrics` mostra.
 *
 * Duas leituras encadeadas e não uma rota "tudo junto": `/app/metrics` é de
 * qualquer papel, o funil padrão já tem o seu próprio cache em outros cantos da
 * tela, e a previsão tem de seguir o MESMO funil que o resto da página mostra.
 * Habilita só quando o funil chegou — sem id não há para onde pedir.
 */
export function usePrevisaoFunil() {
  const funil = useDefaultPipeline(true);
  const pipelineId = funil.data?.pipeline.id;

  return useQuery({
    queryKey: ["previsao", "funil-padrao", pipelineId],
    enabled: !!pipelineId,
    staleTime: 60_000,
    queryFn: async (): Promise<PrevisaoDoFunil> => {
      const res = await apiClient.get<{ data: PrevisaoDoFunil }>(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId as string)}/forecast`,
      );
      return res.data;
    },
  });
}
