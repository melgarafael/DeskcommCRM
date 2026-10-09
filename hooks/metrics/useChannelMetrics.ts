"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { LinhaCanal } from "@/lib/metrics/canais";

/** O corpo de `GET /api/v1/metrics/channels` (issue #2390). */
export interface ChannelMetrics {
  window: { from: string; to: string };
  owner_user_id: string | null;
  channels: LinhaCanal[];
}

/**
 * Quadro "Por canal". Mesma janela da tabela por atendente: sem `from`/`to` a
 * rota corta 30 dias, e o filtro de atendente da página entra como
 * `owner_user_id` (manager+; a RLS continua escopando quem olha).
 */
export function useChannelMetrics(owner: string | null) {
  const qs = owner ? `?owner_user_id=${encodeURIComponent(owner)}` : "";
  return useQuery({
    queryKey: ["metrics", "channels", owner ?? "all"],
    queryFn: async () => apiClient.get<{ data: ChannelMetrics }>(`/api/v1/metrics/channels${qs}`),
    staleTime: 30_000,
  });
}
