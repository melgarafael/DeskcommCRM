/**
 * Interpreta um evento de webhook da Asaas já autenticado e grava o espelho
 * local. Separado da rota para ficar testável sem HTTP.
 *
 * MVP DELIBERADO (dívida declarada, não escondida): a decisão de
 * suspender/reativar por inadimplência é dirigida DIRETO pelo evento de
 * pagamento (`PAYMENT_OVERDUE` suspende na hora, `PAYMENT_CONFIRMED` /
 * `PAYMENT_RECEIVED` reativa na hora) — sem período de tolerância configurável
 * e sem reconciliação ativa para webhook perdido. Fica para depois do MVP de
 * billing (ver Fase 2 do plano do pivot); webhook que falhar em processar fica
 * visível em `webhook_events_log.status='error'`, mas nada hoje reprocessa
 * automaticamente.
 */
import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export interface AsaasWebhookPayment {
  id: string;
  subscription?: string;
  customer: string;
  status: string;
  value: number;
  dueDate?: string;
  invoiceUrl?: string;
}

export interface AsaasWebhookBody {
  event: string;
  payment?: AsaasWebhookPayment;
}

const EVENTOS_DE_COBRANCA_PAGA = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);
const EVENTOS_DE_ATRASO = new Set(["PAYMENT_OVERDUE"]);

export interface ResultadoDoWebhook {
  status: "processed" | "unmatched" | "ignored";
  organizationId?: string;
  detail?: string;
}

export async function processarWebhookAsaas(body: AsaasWebhookBody): Promise<ResultadoDoWebhook> {
  const payment = body.payment;
  if (!payment) return { status: "ignored", detail: "evento sem objeto payment" };

  const admin = createAdminClient();

  // Fonte confiável de organization_id: o registro que NÓS criamos ao abrir a
  // assinatura (subscriptions.ts), nunca um campo solto do payload da Asaas.
  const { data: subscriptionRow } = await admin
    .from("organization_subscriptions")
    .select("id, organization_id, status")
    .eq("asaas_subscription_id", payment.subscription ?? "__sem_subscription__")
    .maybeSingle();

  if (!subscriptionRow) {
    logger.warn("[asaas.webhook] payment sem organization_subscriptions correspondente", {
      asaas_subscription_id: payment.subscription,
      asaas_payment_id: payment.id,
    });
    return { status: "unmatched", detail: "asaas_subscription_id não localizado" };
  }

  const organizationId = subscriptionRow.organization_id;
  const amountCents = Math.round(payment.value * 100);

  await admin.from("billing_invoices").upsert(
    {
      organization_id: organizationId,
      subscription_id: subscriptionRow.id,
      asaas_payment_id: payment.id,
      status: payment.status,
      amount_cents: amountCents,
      due_date: payment.dueDate ?? null,
      paid_at: EVENTOS_DE_COBRANCA_PAGA.has(body.event) ? new Date().toISOString() : null,
      invoice_url: payment.invoiceUrl ?? null,
    },
    { onConflict: "asaas_payment_id" },
  );

  if (EVENTOS_DE_ATRASO.has(body.event)) {
    await suspenderPorInadimplencia(organizationId, subscriptionRow.id);
  } else if (EVENTOS_DE_COBRANCA_PAGA.has(body.event)) {
    await reativarSeSuspensoPorInadimplencia(organizationId, subscriptionRow.id);
  }

  return { status: "processed", organizationId };
}

async function suspenderPorInadimplencia(organizationId: string, subscriptionId: string) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  await admin
    .from("organization_subscriptions")
    .update({ status: "past_due", updated_at: now })
    .eq("id", subscriptionId);

  const { data: org } = await admin
    .from("organizations")
    .select("status")
    .eq("id", organizationId)
    .maybeSingle();
  if (org?.status === "suspended") return; // já suspensa (não sobrescreve motivo administrativo)

  await admin
    .from("organizations")
    .update({ status: "suspended", suspended_at: now, suspended_reason: "billing_overdue" })
    .eq("id", organizationId);

  void audit({
    action: "billing.subscription_suspended_overdue",
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    bypassedRls: true,
    requestId: randomUUID(),
    metadata: { subscription_id: subscriptionId },
  });

  void admin.from("event_log").insert({
    organization_id: organizationId,
    entity_kind: "organization",
    entity_id: organizationId,
    event_type: "billing.subscription_suspended_overdue",
    payload: { subscription_id: subscriptionId },
  });
}

async function reativarSeSuspensoPorInadimplencia(organizationId: string, subscriptionId: string) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  await admin
    .from("organization_subscriptions")
    .update({ status: "active", updated_at: now })
    .eq("id", subscriptionId);

  const { data: org } = await admin
    .from("organizations")
    .select("status, suspended_reason")
    .eq("id", organizationId)
    .maybeSingle();
  // Só reativa o que ELA suspendeu — nunca sobrescreve suspensão administrativa
  // (ex.: revendedor suspendeu por outro motivo) com um pagamento em dia.
  if (org?.status !== "suspended" || org.suspended_reason !== "billing_overdue") return;

  await admin
    .from("organizations")
    .update({ status: "active", suspended_at: null, suspended_reason: null })
    .eq("id", organizationId);

  void audit({
    action: "billing.subscription_reactivated",
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    bypassedRls: true,
    requestId: randomUUID(),
    metadata: { subscription_id: subscriptionId },
  });

  void admin.from("event_log").insert({
    organization_id: organizationId,
    entity_kind: "organization",
    entity_id: organizationId,
    event_type: "billing.subscription_reactivated",
    payload: { subscription_id: subscriptionId },
  });
}
