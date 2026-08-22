/**
 * POST /api/v1/webhooks/asaas — endpoint único (não por-tenant).
 *
 * Diferente de WAHA/Nuvemshop, a Asaas não oferece webhook por-tenant — é um
 * endpoint por CONTA Asaas da plataforma, e é por isso que não há
 * `[token]` no path. Auth por token estático (`asaas-access-token`), não HMAC.
 *
 * Pipeline: valida token -> loga em webhook_events_log (mesma tabela de
 * WAHA/Nuvemshop, CHECK ampliado na migration 0168) -> resolve organização
 * pelo `asaas_subscription_id` já gravado localmente (nunca por campo solto
 * do payload) -> atualiza espelho local + suspende/reativa por inadimplência.
 *
 * Rota INERTE quando BILLING_MODE != asaas: nenhum self-host recebe tráfego
 * real da Asaas (não tem conta configurada), mas a rota responde 503 em vez
 * de tentar processar sem `ASAAS_WEBHOOK_TOKEN` configurado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { isBillingEnabled } from "@/lib/asaas/config";
import { validarTokenDoWebhookAsaas } from "@/lib/asaas/webhook-signature";
import { processarWebhookAsaas, type AsaasWebhookBody } from "@/lib/asaas/webhook-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (!isBillingEnabled()) {
    return fail("unavailable", "Billing não está habilitado nesta instalação", 503, { requestId });
  }

  const rawBody = await req.text();
  const headerToken = req.headers.get("asaas-access-token");
  const admin = createAdminClient();

  if (!validarTokenDoWebhookAsaas(headerToken)) {
    void admin.from("webhook_events_log").insert({
      provider: "asaas",
      http_method: "POST",
      raw_body: rawBody,
      signature_header: headerToken,
      valid_signature: false,
      status: "error",
      error_message: "token inválido",
    });
    void audit({
      action: "billing.webhook_invalid_token",
      requestId,
      metadata: { header_present: Boolean(headerToken) },
    });
    return fail("unauthorized", "Token de webhook inválido", 401, { requestId });
  }

  let body: AsaasWebhookBody;
  try {
    body = JSON.parse(rawBody) as AsaasWebhookBody;
  } catch {
    void admin.from("webhook_events_log").insert({
      provider: "asaas",
      http_method: "POST",
      raw_body: rawBody,
      valid_signature: true,
      status: "error",
      error_message: "json inválido",
    });
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const { data: logRow } = await admin
    .from("webhook_events_log")
    .insert({
      provider: "asaas",
      http_method: "POST",
      raw_body: rawBody,
      payload_parsed: body as unknown as Record<string, unknown>,
      valid_signature: true,
      event_type: body.event,
      external_id: body.payment?.id ?? null,
      status: "received",
    })
    .select("id")
    .single();

  try {
    const resultado = await processarWebhookAsaas(body);
    if (logRow) {
      await admin
        .from("webhook_events_log")
        .update({
          status: resultado.status === "processed" ? "processed" : "error",
          organization_id: resultado.organizationId ?? null,
          error_message: resultado.status === "unmatched" ? resultado.detail : null,
          processed_at: new Date().toISOString(),
        })
        .eq("id", logRow.id);
    }
  } catch (err) {
    logger.error("[asaas.webhook] falha ao processar", {
      request_id: requestId,
      event: body.event,
      error: (err as Error).message,
    });
    if (logRow) {
      await admin
        .from("webhook_events_log")
        .update({ status: "error", error_message: (err as Error).message })
        .eq("id", logRow.id);
    }
    // 200 mesmo em erro de processamento local: a Asaas não tem como corrigir
    // um bug nosso reentregando, e reentrega infinita não ajuda. O erro fica
    // visível em webhook_events_log.status='error' para investigação manual —
    // não há reconciliação automática ainda (dívida declarada no módulo
    // lib/asaas/webhook-events.ts).
  }

  return ok({ received: true }, { requestId });
}
