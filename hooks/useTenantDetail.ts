"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantOrganization {
  id: string;
  slug: string;
  display_name: string;
  legal_name: string | null;
  cnpj: string | null;
  // 'onboarding' não existe na check constraint do banco — é estado derivado
  // (active + onboarded_at null), nunca vem numa linha real.
  status: "active" | "suspended" | "redacted";
  onboarded_at: string | null;
  suspended_at: string | null;
  // Só significa algo com status='suspended'; nulo vale como administrativa.
  // A exclusão recusa a suspensão por cobrança (`lib/tenants/exclusao.ts`).
  // Opcional: fixtures antigas não o têm.
  suspended_kind?: TipoDeSuspensao | null;
  created_at: string;
  settings: Record<string, unknown> | null;
  // Dados cadastrais editáveis (os mesmos de Configurações › Empresa).
  country: string | null;
  timezone: string | null;
  locale: string | null;
  currency: string | null;
  media_retention_days: number | null;
  // Interruptor da limpeza de mídia (0557). Nulo não vem do banco (not null
  // default true); o tipo aceita para fixtures que não o declaram.
  media_retention_enforced: boolean | null;
  dpo_email: string | null;
  privacy_policy_url: string | null;
}

export interface TenantCounts {
  user_count: number;
  conversations_count: number;
  messages_count: number;
  leads_count: number;
  orders_count: number;
  lgpd_requests_pending: number;
  ai_invocations_30d: number;
  waha_sessions_count: number;
}

export interface TenantIntegrations {
  nuvemshop_status: string | null;
  nuvemshop_connected_at: string | null;
}

export interface TenantDetailResponse {
  data: {
    organization: TenantOrganization;
    counts: TenantCounts;
    integrations: TenantIntegrations;
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTenantDetail(id: string) {
  return useQuery({
    queryKey: ["admin", "tenant", id] as const,
    queryFn: () =>
      apiClient.get<TenantDetailResponse>(`/api/v1/admin/tenants/${id}`),
    staleTime: 60_000,
    enabled: !!id,
  });
}
