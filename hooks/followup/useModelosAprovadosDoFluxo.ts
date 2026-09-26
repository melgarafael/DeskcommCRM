"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ModeloAprovadoDoFluxo } from "@/lib/followup/modelos-aprovados";

/**
 * Modelos aprovados do canal que um passo de fluxo consegue enviar sozinho — o
 * único envio que passa com a janela de 24 h fechada. Ver
 * `lib/followup/modelos-aprovados.ts` para o que entra na lista e por quê.
 */
export function useModelosAprovadosDoFluxo() {
  return useQuery({
    queryKey: ["followup-modelos-aprovados"],
    queryFn: async () =>
      apiClient.get<{ data: ModeloAprovadoDoFluxo[] }>("/api/v1/ai/followup-flows/modelos-aprovados"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
