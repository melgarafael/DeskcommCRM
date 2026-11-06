"use client";
/**
 * A lista de números de teste de UM canal — a mesma rota e a mesma chave de
 * cache do painel de Conexões (`components/connections/ChannelAiAccess.tsx`).
 *
 * A rota exige administrador (os telefones autorizados são PII), então quem não
 * pode editar o canal NÃO chama: `enabled` falso é o que evita um 403 virando
 * ruído no console de quem só abriu a tela para olhar.
 */
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { AiAccessMode } from "@/lib/ai/elegibilidade/pre-go-live";

export interface AcessoDaAiLido {
  mode: AiAccessMode;
  test_phone_numbers: string[];
}

export function useAcessoDaAiDoCanal(channelId: string | null | undefined, enabled: boolean) {
  const query = useQuery({
    queryKey: ["channel-ai-access", channelId],
    queryFn: () =>
      apiClient.get<{ data: AcessoDaAiLido }>(`/api/v1/channel-sessions/${channelId}/ai-access`),
    enabled: enabled && Boolean(channelId),
    staleTime: 30_000,
  });
  return { acesso: query.data?.data ?? null, isError: query.isError };
}
