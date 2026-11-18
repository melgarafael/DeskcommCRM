"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { BaldeDeGanhos, Granularidade } from "@/lib/metrics/serie-temporal";

/** O funil de um recorte, como a rota devolve — o id e o nome que o card mostra. */
export interface FunilDaSerie {
  id: string;
  name: string;
}

/** O corpo de `GET /api/v1/metrics/serie` (issue #3024, fatia 1; #4918). */
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
  /**
   * O ESCOPO do número (#4918): o funil recortado, com o nome que o card
   * mostra; `null` quando a conta é a da organização inteira — o comportamento
   * de antes do recorte existir. Vem da RESPOSTA, não da escolha da tela: o
   * card nomeia o que foi de fato contado.
   */
  funil: FunilDaSerie | null;
}

/**
 * A evolução dos ganhos no tempo. Sem `from`/`to`, a mesma janela de 30 dias
 * da tabela por atendente (não o mesmo conjunto — ver `total`), e a RLS
 * continua escopando quem olha — agent vê os próprios negócios, manager+ a
 * organização. A granularidade e o FUNIL são as escolhas da tela, e a série vem
 * pronta da conta pura (`lib/metrics/serie-temporal`).
 *
 * Com `funilId`, a conta é «ganhos daquele funil» (#4918): o funil de suporte
 * declara «Resolvido» como etapa de ganho, então somar o `won` da organização
 * misturava ticket resolvido com venda. Sem ele, o pedido é o de antes — mesmo
 * número, e a chave do cache diz qual dos dois está em cache.
 */
export function useSerieTemporal(granularidade: Granularidade, funilId: string | null = null) {
  return useQuery({
    queryKey: ["metrics", "serie", granularidade, funilId],
    queryFn: async () => {
      const busca = new URLSearchParams({ granularidade });
      if (funilId) busca.set("pipeline_id", funilId);
      return apiClient.get<{ data: SerieTemporal }>(`/api/v1/metrics/serie?${busca.toString()}`);
    },
    staleTime: 30_000,
  });
}
