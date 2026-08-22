/**
 * POST /api/v1/leads/[id]/charge — gera um link de cobrança PaySuite para o lead.
 *
 * Botão manual "Cobrar" no dossiê do lead — decisão do dono do produto de não
 * automatizar por regra ainda (ver discussão que motivou esta rota). O
 * atendente/IA decide QUANDO cobrar; esta rota só faz o passo técnico.
 *
 * Escrita é agent+ (mesmo nível de PATCH /api/v1/leads/[id]) — quem já pode
 * editar o negócio já pode cobrar por ele.
 *
 * `amount_cents` default é `crm_leads.value_cents` do momento, mas o valor
 * FICA gravado na linha de `payments` — se o lead mudar de valor depois, o
 * pagamento já criado continua dizendo o que foi cobrado de fato.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { createPayment, PaySuiteApiError } from "@/lib/payments/paysuite/client";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { formatCentsMZN } from "@/lib/money";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const chargeSchema = z.object({
  amount_cents: z.number().int().positive().optional(),
  method: z.enum(["mpesa", "emola", "credit_card"]).optional(),
  description: z.string().max(125).optional(),
});

function resolveBaseUrl(req: NextRequest): string {
  const envBase = process.env.NEXT_PUBLIC_APP_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  return new URL(req.url).origin;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "payments" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  let rawBody: unknown = {};
  try {
    const text = await req.text();
    rawBody = text ? JSON.parse(text) : {};
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = chargeSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  // Lead via client de sessão — RLS garante que só vem se for da organização ativa.
  const supabase = await createClient();
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, title, value_cents, contact_id")
    .eq("id", leadId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (leadErr) {
    return fail("internal_error", "Erro ao buscar o negócio.", 500, { requestId });
  }
  if (!lead) {
    return fail("not_found", "Negócio não encontrado nesta organização.", 404, { requestId });
  }

  const amountCents = input.amount_cents ?? (lead as { value_cents: number | null }).value_cents;
  if (!amountCents || amountCents <= 0) {
    return fail(
      "invalid_request",
      "Informe amount_cents — o negócio não tem valor definido.",
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const { data: cred, error: credErr } = await admin
    .from("payment_credentials")
    .select("api_token_encrypted, webhook_path_token, status")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "paysuite")
    .maybeSingle();

  if (credErr) {
    return fail("internal_error", "Erro ao buscar credenciais de pagamento.", 500, { requestId });
  }
  if (!cred) {
    return fail(
      "invalid_request",
      "PaySuite não está configurado. Configure em Integrações › PaySuite.",
      422,
      { requestId },
    );
  }

  const { api_token_encrypted: encToken, webhook_path_token: webhookPathToken } = cred as {
    api_token_encrypted: string;
    webhook_path_token: string;
    status: string;
  };
  const apiToken = await decryptWebhookSecret(admin, encToken);
  if (!apiToken) {
    return fail(
      "internal_error",
      "Não consegui decifrar o token do PaySuite — reconfigure a integração.",
      500,
      { requestId },
    );
  }

  const reference = randomUUID();
  const base = resolveBaseUrl(req);

  let created;
  try {
    created = await createPayment(apiToken, {
      amount: (amountCents / 100).toFixed(2),
      reference,
      method: input.method,
      description: input.description ?? `Cobrança: ${(lead as { title: string }).title}`.slice(0, 125),
      webhook_url: `${base}/api/v1/webhooks/payments/paysuite/${webhookPathToken}`,
    });
  } catch (err) {
    const message = err instanceof PaySuiteApiError ? err.message : "Falha ao contactar o PaySuite.";
    logger.error("[leads.charge] PaySuite createPayment falhou", {
      organizationId: activeOrg.orgId,
      leadId,
      error: message,
    });
    return fail("internal_error", message, 502, { requestId });
  }

  const { data: paymentRow, error: insertErr } = await admin
    .from("payments")
    .insert({
      organization_id: activeOrg.orgId,
      lead_id: leadId,
      provider: "paysuite",
      provider_payment_id: created.id,
      reference,
      method: input.method ?? null,
      amount_cents: amountCents,
      currency: "MZN",
      status: "pending",
      checkout_url: created.checkoutUrl,
      created_by_user_id: user.id,
    })
    .select("id, checkout_url, status")
    .single();

  if (insertErr || !paymentRow) {
    logger.error("[leads.charge] falha ao gravar payments — cobrança criada no PaySuite mas sem registro local", {
      organizationId: activeOrg.orgId,
      leadId,
      providerPaymentId: created.id,
      error: insertErr?.message,
    });
    return fail(
      "internal_error",
      "A cobrança foi criada no PaySuite, mas não consegui registrar aqui. Anote o link antes de tentar de novo: " +
        created.checkoutUrl,
      500,
      { requestId },
    );
  }

  await emitLeadActivity(supabase, {
    organizationId: activeOrg.orgId,
    leadId,
    contactId: (lead as { contact_id: string | null }).contact_id,
    type: "payment_charge_created",
    sourceModule: "payments",
    sourceId: (paymentRow as { id: string }).id,
    actor: { type: "user", id: user.id },
    reason: `Link de cobrança gerado: ${formatCentsMZN(amountCents)}`,
    payload: { payment_id: (paymentRow as { id: string }).id, method: input.method ?? null },
  });

  return ok(
    {
      id: (paymentRow as { id: string }).id,
      checkout_url: (paymentRow as { checkout_url: string }).checkout_url,
      status: (paymentRow as { status: string }).status,
    },
    { status: 201, requestId },
  );
}
