"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface FunnelStage {
  stage_id: string;
  stage_name: string;
  position: number;
  count: number;
}

export interface AttendantMetric {
  user_id: string;
  won: number;
  lost: number;
  conversations_handled: number;
  avg_first_response_seconds: number | null;
  /**
   * #3212: a MEDIANA da 1ª resposta humana, ao LADO da média. `null` = não
   * medida (nenhuma conversa com par válido na janela) — NUNCA 0, que diria
   * "respondeu na hora zero".
   */
  median_first_response_seconds: number | null;
  name: string | null;
  email: string | null;
}

export interface AttendantMetrics {
  window: { from: string; to: string };
  owner_user_id: string | null;
  /** #3212: a etiqueta usada no recorte do contato (`null` = sem recorte). */
  excluded_tag: string | null;
  /** #3212: conversas da janela que a etiqueta tirou da conta. */
  excluded_conversations: number;
  funnel: FunnelStage[];
  attendants: AttendantMetric[];
}

/**
 * spec 13 §6 — funil + performance por atendente. `owner` filtra (manager+).
 *
 * #3212: o tipo carrega a MEDIANA (`median_first_response_seconds`) e o recorte
 * declarado (`excluded_tag`/`excluded_conversations`). O parâmetro de recorte da
 * consulta vive na ROTA (`/api/v1/metrics/attendants?excluir_etiqueta=…`); a
 * tela desta fatia só pinta o número, e o campo de filtro por etiqueta é de uma
 * fatia seguinte — declarada fora do escopo no PR.
 */
export function useAttendantMetrics(owner: string | null) {
  const qs = owner ? `?owner_user_id=${encodeURIComponent(owner)}` : "";
  return useQuery({
    queryKey: ["metrics", "attendants", owner ?? "all"],
    queryFn: async () => apiClient.get<{ data: AttendantMetrics }>(`/api/v1/metrics/attendants${qs}`),
    staleTime: 30_000,
  });
}
