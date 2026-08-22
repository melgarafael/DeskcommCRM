/**
 * Cria a assinatura Asaas de um tenant e grava o espelho local
 * `organization_subscriptions`. Não é chamada por rota pública ainda — o
 * signup (Fase 4 do pivot) é quem invoca isto após criar a organização.
 *
 * Falha aqui NUNCA pode travar o fluxo que criou a organização: o chamador
 * decide o que fazer com o erro (ex.: deixar a org ativa e abrir aviso na
 * Central de Avisos para retry manual) — este módulo só propaga o erro, não
 * o engole nem decide política de negócio.
 */
import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { asaasClient, type AsaasBillingType } from "./client";
import { isBillingEnabled, BillingDisabledError } from "./config";

interface CreateSubscriptionInput {
  organizationId: string;
  planId: string;
  asaasCustomerId: string;
  priceCents: number;
  billingInterval: "monthly" | "yearly";
  billingType?: AsaasBillingType;
}

function proximoVencimento(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

export async function createOrganizationSubscription(
  input: CreateSubscriptionInput,
): Promise<{ id: string; asaasSubscriptionId: string }> {
  if (!isBillingEnabled()) throw new BillingDisabledError();

  const subscription = await asaasClient.createSubscription({
    customer: input.asaasCustomerId,
    billingType: input.billingType ?? "UNDEFINED",
    value: input.priceCents / 100,
    cycle: input.billingInterval === "yearly" ? "YEARLY" : "MONTHLY",
    nextDueDate: proximoVencimento(),
    externalReference: input.organizationId,
  });

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("organization_subscriptions")
    .insert({
      organization_id: input.organizationId,
      plan_id: input.planId,
      asaas_customer_id: input.asaasCustomerId,
      asaas_subscription_id: subscription.id,
      status: "incomplete",
    })
    .select("id")
    .single();

  if (error || !row) {
    throw new Error(`Falha ao gravar organization_subscriptions: ${error?.message}`);
  }

  void audit({
    action: "billing.subscription_created",
    organizationId: input.organizationId,
    resourceType: "organization_subscription",
    resourceId: row.id,
    bypassedRls: true,
    requestId: randomUUID(),
    metadata: {
      asaas_subscription_id: subscription.id,
      plan_id: input.planId,
    },
  });

  return { id: row.id, asaasSubscriptionId: subscription.id };
}
