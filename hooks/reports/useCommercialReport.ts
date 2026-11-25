"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RespostaDoRelatorioComercial } from "@/lib/relatorios/comercial";

/**
 * `GET /api/v1/reports/comercial?de&ate[&pipeline_id][&tag]` — os rankings e a
 * lista de negócios ganhos da tela de Faturamento (#4280, #4802 item 4).
 *
 * O PERÍODO É O DA TELA: `de`/`ate` são os mesmos dias civis (`YYYY-MM-DD`,
 * `ate` INCLUSIVO) que a tela de Faturamento manda ao relatório financeiro. Não
 * existe período próprio aqui — dois seletores na mesma tela seriam dois meses
 * diferentes lado a lado.
 *
 * O RECORTE (`pipeline_id`, `tag`) é do bloco de negócios ganhos: vazio = sem
 * recorte. Ele entra na `queryKey` para cada combinação ter o seu cache.
 *
 * O FUSO NÃO VAI NA QUERY: o recorte é o dia civil da ORGANIZAÇÃO, decidido no
 * servidor (`organizations.timezone`). Mandar o fuso do navegador faria duas
 * pessoas da mesma empresa verem meses diferentes.
 */
export function useCommercialReport(periodo: {
  de: string;
  ate: string;
  pipelineId?: string | null;
  tag?: string | null;
}) {
  const pipelineId = periodo.pipelineId || null;
  const tag = periodo.tag || null;
  return useQuery({
    queryKey: ["reports", "comercial", periodo.de, periodo.ate, pipelineId, tag],
    queryFn: async () => {
      const params = new URLSearchParams({ de: periodo.de, ate: periodo.ate });
      if (pipelineId) params.set("pipeline_id", pipelineId);
      if (tag) params.set("tag", tag);
      return apiClient.get<{ data: RespostaDoRelatorioComercial }>(
        `/api/v1/reports/comercial?${params.toString()}`,
      );
    },
    staleTime: 30_000,
    // Trocar o recorte mantém a resposta anterior na tela até a nova chegar: sem
    // isto o bloco inteiro (seletores incluídos) piscava em "Carregando…" a cada
    // escolha, e o seletor que a pessoa acabou de usar sumia debaixo do dedo.
    placeholderData: keepPreviousData,
  });
}
