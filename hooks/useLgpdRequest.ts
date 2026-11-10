"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { LgpdRequest } from "@/hooks/useLgpdRequests";

export interface AuditTrailEntry {
  id: string;
  action: string;
  actor_user_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface LgpdRequestDetailResponse {
  data: {
    request: LgpdRequest & {
      request_payload: Record<string, unknown>;
      result: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    };
    audit_trail: AuditTrailEntry[];
    signed_pdf_url: string | null;
    /**
     * A ligação do `data.json` — a cópia que o PDF resume (issue #2341). Sai
     * junto da do PDF, no mesmo prazo; `null` quando o pedido é anterior ao
     * `json_path` ou a assinatura falhou.
     */
    signed_json_url: string | null;
    /** Quem recebe o envio — mostrado na confirmação da aprovação (doc 134). */
    titular: { nome: string | null; email_destino: string | null };
  };
}

export function useLgpdRequest(id: string) {
  return useQuery({
    queryKey: ["lgpd-request", id],
    queryFn: async () => {
      try {
        return await apiClient.get<LgpdRequestDetailResponse>(
          `/api/v1/lgpd/requests/${id}`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    staleTime: 15_000,
    enabled: Boolean(id),
  });
}
