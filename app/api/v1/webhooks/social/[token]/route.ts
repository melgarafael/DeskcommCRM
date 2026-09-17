import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/api/wrappers";
import { envelopeSchema, verifySocialWebhook } from "@/lib/channels/social/contract";
import { processSocialEvent, unseal } from "@/lib/channels/social/service";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export async function POST(req: NextRequest, context: { params: Promise<{ token: string }> }) {
  const requestId = randomUUID();
  const { token } = await context.params;
  if (!z.uuid().safeParse(token).success)
    return fail("unauthorized", "Webhook inválido.", 401, { requestId });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 1_048_576)
    return fail("invalid_request", "Evento muito grande.", 413, { requestId });
  const db = createAdminClient();
  // Única busca sem org: o token opaco resolve a organização confiável ANTES do payload.
  const { data: row, error } = await db
    .from("social_connections")
    .select("organization_id,account_id,webhook_secret")
    .eq("webhook_token", token)
    .maybeSingle();
  if (error) return fail("internal_error", "Recebimento indisponível.", 503, { requestId });
  if (!row?.webhook_secret) return fail("unauthorized", "Webhook inválido.", 401, { requestId });
  try {
    if (!verifySocialWebhook(raw, req.headers, unseal(row.webhook_secret)))
      return fail("unauthorized", "Assinatura inválida.", 401, { requestId });
    const event = envelopeSchema.safeParse(JSON.parse(raw));
    if (
      !event.success ||
      event.data.subaccount_id !== row.account_id ||
      event.data.id !== req.headers.get("webhook-id")
    )
      return fail("invalid_request", "Evento incompatível com a conexão.", 422, { requestId });
    await processSocialEvent(
      db,
      row.organization_id,
      event.data.id,
      event.data.event,
      event.data.data,
    );
    return ok({ received: true }, { requestId });
  } catch {
    logger.error("Falha ao processar evento social; o provedor deve reenviar.", {
      organization_id: row.organization_id,
      request_id: requestId,
    });
    return fail("internal_error", "Não foi possível processar o evento. Reenvie.", 503, {
      requestId,
    });
  }
}
