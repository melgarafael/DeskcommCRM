"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/**
 * A LISTA DE FUNIS PARA A BUSCA DO TOPO (⌘K) — issue #4593.
 *
 * ─── Por que um hook novo, se `usePipelines` já mora ao lado ────────────────
 *
 * `hooks/pipelines/usePipelines.ts` tem só ESCRITA, e o comentário de lá explica
 * a razão: `GET /api/v1/pipelines` exige `manager` e a tela do Kanban é aberta a
 * qualquer papel, então a leitura da tela vem do Server Component. Aqui a
 * situação é diferente — a paleta precisa da lista em cliente, e só pode
 * perguntar quando o papel alcança a rota.
 *
 * ─── O portão é do CHAMADOR, e é por isso que `enabled` é obrigatório ───────
 *
 * Quem monta a paleta passa `enabled` já resolvido (`roleAtLeast(role,
 * "manager")` mais a visibilidade da tela de Funis). Chamada desligada = zero
 * requisição: um `agent` não leva 403 nem vê o toast de erro da rota — o grupo
 * «Funis» simplesmente não aparece para ele.
 *
 * Leitura com o cliente da sessão: a RLS da organização vale como em qualquer
 * rota, e o papel é conferido no servidor de novo.
 */
export interface FunilDaBusca {
  id: string;
  name: string;
  slug?: string | null;
}

export function usePipelinesDaPaleta(enabled: boolean) {
  return useQuery({
    queryKey: ["pipelines", "busca-do-topo"],
    enabled,
    // A lista muda quando alguém cria, renomeia ou arquiva um funil; 60 s é o
    // mesmo frescor que `useDefaultPipeline` aceita para o seletor do Inbox.
    staleTime: 60_000,
    queryFn: async (): Promise<FunilDaBusca[]> => {
      const res = await apiClient.get<{ data: FunilDaBusca[] }>("/api/v1/pipelines");
      return res.data;
    },
  });
}
