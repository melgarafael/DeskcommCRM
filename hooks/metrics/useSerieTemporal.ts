"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { BaldeDeGanhos, Granularidade } from "@/lib/metrics/serie-temporal";

/** O corpo de `GET /api/v1/metrics/serie` (issue #3024, fatia 1). */
export interface SerieTemporal {
  window: { from: string; to: string };
  granularidade: Granularidade;
  baldes: BaldeDeGanhos[];
  /**
   * A soma dos baldes. NÃO é o `won` da tabela por atendente: aquela conta só
   * negócio com responsável e segue o filtro de atendente; esta, todo ganho visível.
   */
  total: number;
  /** `true` quando a leitura bateu no teto de páginas e a série está cortada. */
  truncado: boolean;
}

/**
 * A evolução dos ganhos no tempo. Sem `from`/`to`, a mesma janela de 30 dias
 * da tabela por atendente (não o mesmo conjunto — ver `total`), e a RLS
 * continua escopando quem olha — agent vê os próprios negócios, manager+ a
 * organização. A granularidade é a única
 * escolha da tela, e a série vem pronta da conta pura (`lib/metrics/serie-temporal`).
 */
export function useSerieTemporal(granularidade: Granularidade) {
  return useQuery({
    queryKey: ["metrics", "serie", granularidade],
    queryFn: async () =>
      apiClient.get<{ data: SerieTemporal }>(
        `/api/v1/metrics/serie?granularidade=${encodeURIComponent(granularidade)}`,
      ),
    staleTime: 30_000,
  });
}
