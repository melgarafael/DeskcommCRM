/**
 * POST /api/v1/webhooks/payments/paysuite/[token] — confirmação de pagamento.
 *
 * O token na URL resolve a organização (`payment_credentials.webhook_path_token`)
 * — mesmo desenho dos outros webhooks de canal por token na URL: a
 * organização nunca aparece na URL, só um token opaco.
 *
 * Assinatura: PaySuite manda `X-Signature` = HMAC-SHA256 hex do corpo cru,
 * com o "webhook secret" do dashboard deles (documentado em paysuite.tech/docs).
 * É o MESMO algoritmo que `verifyInboundSignature` já implementa para os
 * webhooks de captação — reaproveitado aqui, não reescrito.
 *
 * Evento que não interessa (tipo desconhecido) responde 200: reentrega de um
 * evento que nunca vamos processar seria retry para sempre. Assinatura
 * inválida responde 401 — não 404 — porque o token já foi resolvido; esconder
 * a existência do endpoint depois de já tê-la confirmado não protege nada.
 *
 * Pagamento sem linha correspondente (`provider_payment_id` não encontrado)
 * também responde 200 e só loga um aviso: reenviar o mesmo webhook não cria a
 * linha que falta, então recusar geraria retry infinito por um problema que a
 * reentrega nunca resolve. Fica registrado como dívida — não há hoje um jeito
 * de um operador VER esse caso pela tela (não há aviso na Central para isto).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { verifyInboundSignature } from "@/lib/webhooks/inbound";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { formatCentsMZN } from "@/lib/money";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PaySuiteWebhookBody {
  event?: string;
  data?: { id?: string; amount?: number; reference?: string };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const admin = createAdminClient();

  const { data: cred } = await admin
    .from("payment_credentials")
    .select("organization_id, webhook_secret_encrypted")
    .eq("webhook_path_token", token)
    .eq("provider", "paysuite")
    .maybeSingle();

  if (!cred) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }
  const { organization_id: organizationId, webhook_secret_encrypted: encryptedSecret } = cred as {
    organization_id: string;
    webhook_secret_encrypted: string;
  };

  const rawBody = await req.text();
  const secret = await decryptWebhookSecret(admin, encryptedSecret);

  if (!secret || !verifyInboundSignature(rawBody, req.headers.get("x-signature"), secret)) {
    logger.warn("[webhooks.paysuite] assinatura inválida ou segredo indisponível", {
      organizationId,
    });
    return fail("unauthorized", "assinatura inválida", 401, { requestId });
  }

  let body: PaySuiteWebhookBody;
  try {
    body = JSON.parse(rawBody) as PaySuiteWebhookBody;
  } catch {
    return fail("invalid_request", "corpo não é JSON válido", 400, { requestId });
  }

  if (body.event !== "payment.success" && body.event !== "payment.failed") {
    return ok({ status: "ignored", reason: "evento_desconhecido" }, { requestId });
  }

  const providerPaymentId = body.data?.id;
  if (!providerPaymentId) {
    return ok({ status: "ignored", reason: "sem_id_de_pagamento" }, { requestId });
  }

  const novoStatus = body.event === "payment.success" ? "paid" : "failed";

  const { data: updated, error: updateErr } = await admin
    .from("payments")
    .update({ status: novoStatus, raw_webhook_payload: body })
    .eq("organization_id", organizationId)
    .eq("provider", "paysuite")
    .eq("provider_payment_id", providerPaymentId)
    .select("id, lead_id, amount_cents")
    .maybeSingle();

  if (updateErr) {
    logger.error("[webhooks.paysuite] falha ao atualizar pagamento", {
      organizationId,
      error: updateErr.message,
    });
    // Falha de ESCRITA (não de conteúdo): aqui sim queremos reentrega.
    return fail("internal_error", "falha ao gravar confirmação", 500, { requestId });
  }

  if (!updated) {
    logger.warn("[webhooks.paysuite] webhook para pagamento sem linha correspondente", {
      organizationId,
      providerPaymentId,
    });
    return ok({ status: "ignored", reason: "pagamento_nao_encontrado" }, { requestId });
  }

  const row = updated as { id: string; lead_id: string | null; amount_cents: number };

  // Só registra — não mexe em etapa/funil (decisão do dono do produto: o
  // atendente decide manualmente o que fazer com um pagamento confirmado).
  if (novoStatus === "paid" && row.lead_id) {
    await emitLeadActivity(admin, {
      organizationId,
      leadId: row.lead_id,
      type: "payment_confirmed",
      sourceModule: "payments",
      sourceId: row.id,
      actor: { type: "webhook_source", id: "paysuite" },
      reason: `Pagamento confirmado: ${formatCentsMZN(row.amount_cents)}`,
      payload: { payment_id: row.id },
    });
  }

  return ok({ status: "processed" }, { requestId });
}
