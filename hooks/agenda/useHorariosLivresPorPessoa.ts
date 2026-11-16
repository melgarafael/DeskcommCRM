"use client";

import { useQueries } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

import type { HorariosLivresFiltro, HorariosLivresResposta } from "./useHorariosLivres";

/**
 * Os horários livres de CADA profissional, para o quadro (#4186).
 *
 * Uma consulta por pessoa à MESMA rota que o painel de marcação e o agente usam
 * (`/api/v1/agenda/horarios-livres` com `owner_user_id`) — o quadro não inventa
 * disponibilidade, ele pergunta ao motor linha por linha. A chave do React Query
 * é a MESMA de `useHorariosLivres`, então abrir o painel na pessoa que já foi
 * consultada aqui reaproveita o cache em vez de pedir de novo.
 *
 * Sem `showApiError` por consulta, ao contrário de `useHorariosLivres`: com dez
 * profissionais e a rota fora do ar, seriam dez toasts iguais. A falha volta por
 * pessoa (`falhou`) e o quadro a diz uma vez, em texto.
 */
export function useHorariosLivresPorPessoa(
  tipoId: string | null,
  pessoaIds: string[],
  recorte: { de: string; ate: string },
): Record<
  string,
  { slots: HorariosLivresResposta["slots"] | null; falhou: boolean; publicou: boolean }
> {
  const resultados = useQueries({
    queries: pessoaIds.map((pessoaId) => {
      const filtro: HorariosLivresFiltro | null = tipoId
        ? { event_type_id: tipoId, owner_user_id: pessoaId, de: recorte.de, ate: recorte.ate }
        : null;
      return {
        queryKey: ["agenda", "horarios-livres", filtro],
        enabled: filtro !== null,
        retry: false,
        queryFn: async () => {
          const qs = new URLSearchParams({
            event_type_id: filtro!.event_type_id,
            owner_user_id: pessoaId,
            de: filtro!.de,
            ate: filtro!.ate,
          });
          const r = await apiClient.get<{ data: HorariosLivresResposta }>(
            `/api/v1/agenda/horarios-livres?${qs.toString()}`,
          );
          return (
            (r as unknown as { data: HorariosLivresResposta }).data ??
            (r as unknown as HorariosLivresResposta)
          );
        },
      };
    }),
  });

  const porPessoa: Record<
    string,
    { slots: HorariosLivresResposta["slots"] | null; falhou: boolean; publicou: boolean }
  > = {};
  pessoaIds.forEach((id, i) => {
    const r = resultados[i];
    porPessoa[id] = {
      slots: r?.data?.slots ?? null,
      falhou: r?.isError ?? false,
      publicou: r?.data?.publicou_horarios ?? true,
    };
  });
  return porPessoa;
}
