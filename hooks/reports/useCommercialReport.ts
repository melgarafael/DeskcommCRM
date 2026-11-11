"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RespostaDoRelatorioComercial } from "@/lib/relatorios/comercial";

/**
 * `GET /api/v1/reports/comercial?de&ate` — os rankings de negócios ganhos da
 * tela de Faturamento (#4280).
 *
 * O PERÍODO É O DA TELA: `de`/`ate` são os mesmos dias civis (`YYYY-MM-DD`,
 * `ate` INCLUSIVO) que a tela de Faturamento manda ao relatório financeiro. Não
 * existe período próprio aqui — dois seletores na mesma tela seriam dois meses
 * diferentes lado a lado.
 *
 * O FUSO NÃO VAI NA QUERY: o recorte é o dia civil da ORGANIZAÇÃO, decidido no
 * servidor (`organizations.timezone`). Mandar o fuso do navegador faria duas
 * pessoas da mesma empresa verem meses diferentes.
 */
export function useCommercialReport(periodo: { de: string; ate: string }) {
  return useQuery({
    queryKey: ["reports", "comercial", periodo.de, periodo.ate],
    queryFn: async () =>
      apiClient.get<{ data: RespostaDoRelatorioComercial }>(
        `/api/v1/reports/comercial?de=${encodeURIComponent(periodo.de)}&ate=${encodeURIComponent(periodo.ate)}`,
      ),
    staleTime: 30_000,
  });
}
