"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface BillingPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_interval: "monthly" | "yearly";
  features: Record<string, unknown>;
}

interface BillingPlansResponse {
  data: BillingPlan[];
}

/**
 * Lista vazia = instalação sem planos de billing configurados (self-host
 * típico) — o chamador trata isso como "não oferecer cobrança", sem precisar
 * saber de BILLING_MODE separadamente.
 */
export function useBillingPlans() {
  return useQuery({
    queryKey: ["billing", "plans"] as const,
    queryFn: () => apiClient.get<BillingPlansResponse>("/api/v1/billing/plans"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}
