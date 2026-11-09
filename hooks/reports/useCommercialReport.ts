"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RespostaDoRelatorioComercial } from "@/lib/relatorios/comercial";

/**
 * `GET /api/v1/reports/comercial?de&ate` — o painel comercial da #4280.
 *
 * O FUSO NÃO VAI NA QUERY: o recorte é o dia civil da ORGANIZAÇÃO, decidido no
 * servidor (`organizations.timezone`). Mandar o fuso do navegador faria duas
 * pessoas da mesma empresa verem meses diferentes — o defeito que
 * `/reports/tags` evita pedindo `tz`, e que aqui é evitado na origem.
 *
 * `de`/`ate` são dias civis (`YYYY-MM-DD`) e o `ate` é INCLUSIVO. Sem período
 * (`null`), o servidor responde o MÊS CORRENTE dele — e devolve `padrao: true`
 * com a janela usada, que é de onde a tela preenche os campos.
 */
export function useCommercialReport(periodo: { de: string; ate: string } | null) {
  const query = periodo
    ? `?de=${encodeURIComponent(periodo.de)}&ate=${encodeURIComponent(periodo.ate)}`
    : "";
  return useQuery({
    queryKey: ["reports", "comercial", periodo?.de ?? "padrao", periodo?.ate ?? "padrao"],
    queryFn: async () =>
      apiClient.get<{ data: RespostaDoRelatorioComercial }>(
        `/api/v1/reports/comercial${query}`,
      ),
    staleTime: 30_000,
  });
}
