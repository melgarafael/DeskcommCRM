"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateTenantPayload {
  display_name: string;
  slug: string;
  legal_name?: string;
  cnpj?: string;
  plan?: "standard" | "pro" | "enterprise";
  owner_email: string;
  /** billing_plans.id — só tem efeito quando a instância roda BILLING_MODE=asaas. */
  plan_id?: string;
}

export interface CreateTenantResponse {
  data: {
    id: string;
    slug: string;
    display_name: string;
    owner_invite_dispatched: boolean;
    owner_invite_error: string | null;
    billing_error: string | null;
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCreateTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateTenantPayload) =>
      apiClient.post<CreateTenantResponse>("/api/v1/admin/tenants", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
    },
  });
}
