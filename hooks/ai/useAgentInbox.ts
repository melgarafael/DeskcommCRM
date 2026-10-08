"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AgentInboxSeverity } from "@/lib/ai/agent-inbox-copy";
import type { DestinoDoAviso } from "@/lib/ai/inbox-destino";

export interface AgentInboxItem {
  id: string;
  kind: string;
  severity: AgentInboxSeverity;
  title: string;
  body: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  status: "open" | "ack" | "resolved";
  created_at: string;
  destination: DestinoDoAviso;
  /** Só nos avisos da cobrança, e só para quem administra: o link que paga em um clique. */
  link_de_pagamento?: string | null;
}

export interface AgentInboxData {
  items: AgentInboxItem[];
  open_count: number;
}

/** Central de avisos do runtime (F1). Polling 30s — avisos nascem no worker. */
export function useAgentInbox(status: "open" | "resolved" = "open") {
  const podeConsultar = usePermission("ai.inbox.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: ["agent-inbox", status],
    // 30 s: é esta leitura que toca o som da etapa que avisa e do pedido de
    // pessoa (`useSonsDaCentral`) — um minuto de atraso num pedido de pessoa pesa.
    refetchInterval: 30_000,
    queryFn: () =>
      apiClient
        .get<{ data: AgentInboxData }>(`/api/v1/ai/inbox?status=${status}`)
        .then((r) => r.data),
  });
}

export function useUpdateInboxItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: "open" | "resolved" }) =>
      apiClient.patch(`/api/v1/ai/inbox/${id}`, { status }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["agent-inbox"] }),
  });
}

/**
 * Resolve TODOS os avisos abertos da organização de uma vez.
 *
 * Não recebe ids: quem decide o conjunto é o servidor, a partir da org do
 * cookie. Mandar a lista da tela seria pior — a tela carrega no máximo 50, e
 * "marcar todos" com 144 abertos precisa alcançar os 144.
 */
export function useResolveAllInboxItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<{ data: { resolved_count: number } }>(
      "/api/v1/ai/inbox/resolve-all",
      {},
    ),
    onSettled: () => qc.invalidateQueries({ queryKey: ["agent-inbox"] }),
  });
}
