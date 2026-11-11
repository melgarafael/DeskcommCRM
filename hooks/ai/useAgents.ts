"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AgentRow } from "./useAgent";

interface ListResponse {
  data: AgentRow[];
}

export const agentsListQueryKey = ["ai", "agents", "list"] as const;

export function useAgentsList(opts?: { initialData?: AgentRow[] }) {
  return useQuery({
    queryKey: agentsListQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<ListResponse>("/api/v1/ai/agents");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
  });
}

/**
 * Recarrega a lista de agentes depois de uma mutação feita pela tela (duplicar,
 * renomear, pausar, arquivar).
 *
 * `router.refresh()` sozinho NÃO basta: ele refaz o Server Component e entrega
 * um `initialData` novo a `useAgentsList`, mas o React Query só usa
 * `initialData` quando a chave ainda não está no cache — com o cache cheio, a
 * lista seguia pintando o estado velho até a pessoa apertar F5. Invalidar a
 * chave refaz a busca por `/api/v1/ai/agents`; o refresh continua para o resto
 * da página que vem do servidor.
 */
export function useRecarregarListaDeAgentes() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    router.refresh();
    await queryClient.invalidateQueries({ queryKey: agentsListQueryKey });
  };
}
