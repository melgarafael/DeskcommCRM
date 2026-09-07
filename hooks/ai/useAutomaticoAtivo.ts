"use client";
import { useQuery } from "@tanstack/react-query";

import { usePermission } from "@/hooks/auth/AuthProvider";

import { apiClient } from "@/lib/api/client";

/**
 * A org tem atendimento automático de pé?
 *
 * Uma requisição por sessão de Inbox (o `staleTime` é longo de propósito: agente
 * novo é evento raro, e esta pergunta só decide um rótulo). Falha e carregamento
 * devolvem `undefined`, nunca `false` — dizer "não há automático" por causa de
 * uma leitura que não voltou seria a mesma mentira ao contrário, e quem consome
 * trata `undefined` como "não afirme nada".
 */
export function useAutomaticoAtivo() {
  const podeConsultar = usePermission("ai.automatico.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: ["ai", "automatico-ativo"],
    queryFn: async () => {
      const r = await apiClient.get<{ data: { ativo: boolean } }>(
        "/api/v1/ai/automatico-ativo",
      );
      return r.data.ativo;
    },
    staleTime: 5 * 60_000,
    // Silencioso de propósito: é um rótulo, não uma operação. Um toast de erro
    // aqui interromperia o atendimento por causa de um adjetivo.
    retry: 1,
  });
}
