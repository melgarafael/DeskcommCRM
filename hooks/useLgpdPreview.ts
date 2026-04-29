"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export interface LgpdPreviewContact {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null; // already masked: a***@domain
  phone_number: string | null; // already masked: (**) ****-last4
  cpf_present: boolean; // CPF value is NEVER returned
  birthdate: string | null;
  is_blocked: boolean;
  is_anonymized: boolean;
  tags: string[];
  source: string | null;
  created_at: string;
  last_activity_at: string | null;
}

export interface LgpdPreviewCounts {
  conversations: number;
  messages_total: number;
  leads: number;
  orders: number;
  activities: number;
  audit_entries: number;
  consents: number;
}

export interface LgpdPreviewResponse {
  data: {
    request_id: string;
    request_type: string;
    no_local_footprint: boolean;
    generated_at: string;
    contact: LgpdPreviewContact | null;
    counts: LgpdPreviewCounts;
    sample: {
      conversations: unknown[];
      messages_recent: unknown[];
      leads: unknown[];
      orders: unknown[];
      activities: unknown[];
      audit_entries: unknown[];
      consents: unknown[];
    };
  };
}

export function useLgpdPreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ["lgpd-preview", id],
    queryFn: async () => {
      try {
        return await apiClient.get<LgpdPreviewResponse>(
          `/api/v1/lgpd/requests/${id}/preview`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    staleTime: 60_000,
    enabled: Boolean(id) && enabled,
  });
}
