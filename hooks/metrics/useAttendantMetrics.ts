"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";

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
  name: string | null;
  email: string | null;
}

export interface AttendantMetrics {
  window: { from: string; to: string };
  owner_user_id: string | null;
  funnel: FunnelStage[];
  attendants: AttendantMetric[];
}

/**
 * spec 13 §6 — funil + performance por atendente. `owner` filtra (manager+).
 *
 * A ORGANIZAÇÃO ATIVA ENTRA NA CHAVE (issue #2313).
 *
 * A rota `/api/v1/metrics/attendants` resolve o escopo no cookie `active_org`
 * (`requireRole` → `fn_attendant_metrics(p_org=…)`), ou seja: a MESMA URL
 * devolve o funil de quem estiver ativa naquele instante. Uma chave sem a
 * organização faz as duas empresas dividirem UMA entrada de cache — a gravada
 * para a organização B é servida para a A, e o card saiu com o título
 * "Funil · 0 abertos" mostrando as etapas da organização anterior depois da
 * troca (Ctrl+F5 era a única saída medida pelo autor da issue).
 *
 * A chave é a garantia LOCAL do escopo: ela vale mesmo quando a troca não zera
 * o `QueryClient`. O zério de hoje é o `key={…activeOrg?.orgId…}` do
 * `Providers` em `hooks/auth/AuthProvider.tsx` — que só dispara quando a troca
 * chega pelas props do layout DESTA aba. O cookie, porém, é da sessão inteira
 * (trocar numa aba troca em todas, como apontou o comentário na própria
 * issue), e aí esta aba continua com a organização antiga no cliente enquanto
 * a rota já responde pela nova: sem a org na chave, a resposta nova é gravada
 * na entrada da organização errada.
 */
export function useAttendantMetrics(owner: string | null) {
  const orgId = useActiveOrg()?.orgId ?? null;
  const qs = owner ? `?owner_user_id=${encodeURIComponent(owner)}` : "";
  return useQuery({
    queryKey: ["metrics", "attendants", orgId ?? "sem-org", owner ?? "all"],
    queryFn: async () => apiClient.get<{ data: AttendantMetrics }>(`/api/v1/metrics/attendants${qs}`),
    staleTime: 30_000,
  });
}
