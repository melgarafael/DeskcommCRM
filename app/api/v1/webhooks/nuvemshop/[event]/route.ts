/**
 * POST /api/v1/webhooks/nuvemshop/[event]
 *
 * Catch-all receiver for the 8 mandatory Nuvemshop webhooks. Behavior:
 *  1. Read raw body (for HMAC verification — must NOT be re-stringified).
 *  2. Parse JSON, look up tenant_integrations by store_id (in store_metadata).
 *  3. Verify HMAC SHA256 using the per-tenant webhook_secret_encrypted (=
 *     app client_secret at connect time).
 *  4. Insert webhook_events_log; rely on the partial unique constraint to
 *     deduplicate (provider, organization_id, external_id) for idempotency.
 *  5. Emit a row in event_log via the `emit_event` SQL function. Workers
 *     consume from there — no heavy processing inside the request lifecycle.
 *  6. Always 200 quickly (Nuvemshop disables webhooks after 5 consecutive 5xx).
 */

import type { NextRequest, NextResponse } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { slugToEvent } from "@/lib/nuvemshop/config";
import { verifyHmac } from "@/lib/nuvemshop/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ event: string }>;
}

interface NuvemshopPayload {
  store_id?: number | string;
  event?: string;
  id?: number | string;
  // Per-event extras (order id, product id, etc) — opaque here.
}

function externalIdFor(event: string, body: NuvemshopPayload): string {
  const storeId = body.store_id !== undefined ? String(body.store_id) : "unknown";
  const id = body.id !== undefined ? String(body.id) : "noid";
  return `${event}:${storeId}:${id}`;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { event: slug } = await ctx.params;
  const event = slugToEvent(slug);
  if (!event) {
    return fail("not_found", `unknown nuvemshop event slug: ${slug}`, 404);
  }

  const rawBody = await req.text();
  let body: NuvemshopPayload;
  try {
    body = JSON.parse(rawBody) as NuvemshopPayload;
  } catch {
    return fail("invalid_request", "invalid_json", 400);
  }

  const storeId = body.store_id !== undefined ? String(body.store_id) : "";
  if (!storeId) {
    return fail("invalid_request", "missing store_id", 400);
  }

  const admin = createAdminClient();

  // Look up the tenant integration by store_id stored in store_metadata.
  const { data: integration, error: lookupErr } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, webhook_secret_encrypted")
    .eq("provider", "nuvemshop")
    .eq("store_metadata->>store_id", storeId)
    .maybeSingle();

  if (lookupErr || !integration) {
    // No tenant matches — could be a stale subscription or test ping. We
    // intentionally return 200 so Nuvemshop stops retrying, but log silently.
    return ok({ accepted: false, reason: "tenant_not_found" });
  }

  // Decrypt webhook secret (= app client_secret at connect time).
  const dec = await admin.rpc("fn_decrypt_oauth", {
    ciphertext: integration.webhook_secret_encrypted,
  });
  if (dec.error || !dec.data) {
    await audit({
      action: "nuvemshop.webhook_invalid_signature",
      organizationId: integration.organization_id,
      metadata: { reason: "decrypt_failed", event },
    });
    return fail("internal_error", "decrypt_failed", 500);
  }
  const clientSecret = dec.data as string;

  const sigHeader =
    req.headers.get("x-linkedstore-hmac-sha256") ??
    req.headers.get("X-Linkedstore-Hmac-Sha256");
  const valid = verifyHmac(rawBody, sigHeader, clientSecret);
  if (!valid) {
    await audit({
      action: "nuvemshop.webhook_invalid_signature",
      organizationId: integration.organization_id,
      metadata: { event, store_id: storeId },
    });
    return fail("unauthenticated", "invalid_signature", 401);
  }

  const externalId = externalIdFor(event, body);

  // Idempotent log insert. webhook_events_log doesn't have a unique constraint
  // on (provider, external_id) yet, so we manually check for an existing row.
  const { data: existing } = await admin
    .from("webhook_events_log")
    .select("id")
    .eq("provider", "nuvemshop")
    .eq("organization_id", integration.organization_id)
    .eq("external_id", externalId)
    .maybeSingle();

  if (existing) {
    return ok({ accepted: true, idempotent: true });
  }

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    // Strip auth-sensitive headers from the log.
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });

  const { error: insertErr } = await admin.from("webhook_events_log").insert({
    organization_id: integration.organization_id,
    provider: "nuvemshop",
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: body,
    signature_header: sigHeader ?? null,
    valid_signature: true,
    event_type: event,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });

  if (insertErr) {
    // Don't block on log insert failures — still emit the event.
    console.error("[nuvemshop.webhook] webhook_events_log insert failed", insertErr.message);
  }

  // ── O CATÁLOGO NUNCA CHEGAVA AO ACERVO ────────────────────────────────────
  //
  // Dois desencontros no mesmo caminho, e cada um sozinho já bastava para o
  // material do agente ficar vazio para sempre:
  //
  //  1. NOME. Produto virava `nuvemshop.product_created|updated|deleted` pelo
  //     mapeamento genérico, e o indexador (`workers/rag-indexer.handler.ts`)
  //     escuta `nuvemshop.product_synced` — um nome que NINGUÉM emitia. Os
  //     três nomes de produto também não tinham consumidor nenhum.
  //  2. CAMPO. `fonteDoEvento` lê `payload.product_id`, e o corpo cru da
  //     plataforma traz `id`. Mesmo com o nome certo, o evento morreria em
  //     `evento_sem_product_id`.
  //
  // Medido numa instalação real: integração `healthy`, 8 webhooks
  // assinados, 879 produtos na loja e ZERO no acervo. O modo de falha é mudo —
  // conexão saudável, auditoria limpa, acervo vazio.
  //
  // O nome do evento de produto passa a ser o que o indexador escuta, e o
  // payload ganha `product_id` normalizado SEM perder o corpo original.
  const ehProduto = event.startsWith("product/");
  // event_type for event_log must match `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`.
  // Map e.g. "order/created" -> "nuvemshop.order_created".
  const eventLogType = ehProduto
    ? "nuvemshop.product_synced"
    : `nuvemshop.${event.replace("/", "_")}`;
  const { error: emitErr } = await admin.rpc("emit_event", {
    p_event_type: eventLogType,
    p_entity_kind: "nuvemshop_webhook",
    p_entity_id: null,
    p_payload: ehProduto
      ? ({
          ...(body as unknown as Record<string, unknown>),
          product_id: String((body as { id?: unknown }).id ?? ""),
          acao: event.slice("product/".length),
        } as Record<string, unknown>)
      : (body as unknown as Record<string, unknown>),
    p_metadata: { external_id: externalId, store_id: storeId },
    p_organization_id: integration.organization_id,
  });
  if (emitErr) {
    console.error("[nuvemshop.webhook] emit_event failed", emitErr.message);
  }

  await audit({
    action: "nuvemshop.webhook_received",
    organizationId: integration.organization_id,
    resourceType: "nuvemshop_webhook",
    resourceId: externalId,
    metadata: { event, store_id: storeId },
  });

  return ok({ accepted: true });
}
