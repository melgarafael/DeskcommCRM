"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { CompraDoContato } from "@/lib/leads/compras-do-contato";

/**
 * As compras ganhas do contato (issue #3179), lidas pela rota dedicada.
 *
 * Uma rota só serve aos DOIS lugares que mostram a seção (painel do Inbox e ficha
 * do contato): a consulta é a MESMA (todos os funis, só `status='won'`), e duas
 * leituras divergiriam com o tempo — a régua do repo é uma decisão num lugar.
 */
export function useUltimasCompras(contactId: string | null) {
  return useQuery({
    queryKey: ["ultimas-compras", contactId],
    enabled: Boolean(contactId),
    staleTime: 30_000,
    queryFn: async (): Promise<CompraDoContato[]> => {
      const res = await apiClient.get<{ data: { compras: CompraDoContato[] } }>(
        `/api/v1/contacts/${contactId}/compras`,
      );
      return res.data.compras ?? [];
    },
  });
}
