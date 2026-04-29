/**
 * POST /api/v1/webhooks/nuvemshop/customer-data-request
 *
 * Receives Nuvemshop `customer/data_request` LGPD webhook.
 * Flow (Spec 06 §5.6, CLAUDE.md LGPD rules L-01..L-06, Story S-08.02):
 *
 *  1. Read raw body (must not be re-stringified — needed for HMAC).
 *  2. Parse JSON and extract store_id.
 *  3. Resolve organization_id from tenant_integrations by store_id (NOT from body).
 *  4. Decrypt and verify HMAC SHA256 (timingSafeEqual).
 *  5. Idempotency: insert webhook_events_log; skip if duplicate (already ack'd).
 *  6. Resolve internal contact by Nuvemshop customer id (may be null — L-03).
 *  7. Insert lgpd_requests (due_at = now + 7 BR business days, per L-02).
 *  8. Emit lgpd.data_request_received on event_log for the async export-worker (S-08.04).
 *  9. Audit log (no raw PII — ids only).
 * 10. Return 200 within <5s.
 */

import type { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createLgpdRequest, findContactByExternalId } from "@/lib/lgpd/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NuvemshopCustomerDataRequestPayload {
  store_id?: number | string;
  /** Optional event id for deduplication. */
  event_id?: string;
  customer?: {
    id?: number | string;
    email?: string | null;
    phone?: string | null;
    [k: string]: unknown;
  };
  orders_requested?: Array<number | string>;
  [k: string]: unknown;
}

interface DeliveryInfo {
  method: "email";
  address: string | null;
}

// ---------------------------------------------------------------------------
// HMAC verification (mirrors customer-redact pattern)
// ---------------------------------------------------------------------------

function verifyHmacSha256(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let received: Buffer;
  try {
    received = Buffer.from(signatureHeader.trim(), "hex");
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  try {
    return timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Read raw body for HMAC
  const rawBody = await req.text();

  // 2. Parse JSON
  let body: NuvemshopCustomerDataRequestPayload;
  try {
    body = JSON.parse(rawBody) as NuvemshopCustomerDataRequestPayload;
  } catch {
    return fail("invalid_request", "invalid_json", 400);
  }

  const storeId = body.store_id !== undefined ? String(body.store_id) : "";
  if (!storeId) {
    return fail("invalid_request", "missing store_id", 400);
  }

  const admin = createAdminClient();

  // 3. Resolve organization from tenant_integrations
  //    organization_id is resolved from a trusted source (the store_id lookup on DB),
  //    never from the request body.
  const { data: integration, error: lookupErr } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, webhook_secret_encrypted")
    .eq("provider", "nuvemshop")
    .eq("store_metadata->>store_id", storeId)
    .maybeSingle();

  if (lookupErr || !integration) {
    console.warn(`[lgpd-customer-data-request] tenant not found for store_id=${storeId}`);
    return fail("not_found", "integration_not_found", 404);
  }

  const orgId: string = integration.organization_id;

  // 4. Decrypt webhook secret and verify HMAC
  const dec = await admin.rpc("fn_decrypt_oauth", {
    ciphertext: integration.webhook_secret_encrypted,
  });

  if (dec.error || !dec.data) {
    console.error(
      `[lgpd-customer-data-request] decrypt failed for org=${orgId}: ${dec.error?.message}`,
    );
    await audit({
      action: "webhook.hmac_invalid",
      organizationId: orgId,
      metadata: {
        reason: "decrypt_failed",
        event: "customer/data_request",
        store_id: storeId,
      },
    });
    return fail("internal_error", "decrypt_failed", 500);
  }

  const clientSecret = dec.data as string;
  const sigHeader =
    req.headers.get("x-linkedstore-hmac-sha256") ??
    req.headers.get("X-Linkedstore-Hmac-Sha256");

  if (!verifyHmacSha256(rawBody, sigHeader, clientSecret)) {
    await audit({
      action: "webhook.hmac_invalid",
      organizationId: orgId,
      metadata: { event: "customer/data_request", store_id: storeId },
    });
    console.warn(
      `[lgpd-customer-data-request] HMAC invalid for org=${orgId} store_id=${storeId}`,
    );
    return fail("unauthenticated", "invalid_signature", 401);
  }

  // 5. Idempotency — use webhook_events_log unique key (org, provider, event_type, external_id)
  const externalEventId =
    body.event_id ??
    // Stable fallback: hash of store_id + customer_id
    (() => {
      const raw = `customer/data_request:${storeId}:${String(body.customer?.id ?? "unknown")}`;
      return createHmac("sha256", clientSecret).update(raw).digest("hex").slice(0, 32);
    })();

  // Collect safe headers (strip sensitive ones) for the log
  const safeHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "authorization" || k === "cookie") return;
    safeHeaders[key] = value;
  });

  const { error: logInsertErr, data: logInserted } = await admin
    .from("webhook_events_log")
    .insert({
      organization_id: orgId,
      provider: "nuvemshop",
      http_method: "POST",
      headers: safeHeaders,
      raw_body: rawBody,
      payload_parsed: body as unknown as Record<string, unknown>,
      signature_header: sigHeader ?? null,
      valid_signature: true,
      event_type: "customer/data_request",
      external_id: externalEventId,
      status: "received",
      attempts: 0,
    })
    .select("id")
    .single();

  if (logInsertErr) {
    // Code 23505 = unique_violation → duplicate event, ack silently
    if ((logInsertErr as { code?: string }).code === "23505") {
      return ok({ received: true, idempotent: true });
    }
    console.error(
      `[lgpd-customer-data-request] webhook_events_log insert error: ${logInsertErr.message}`,
    );
    // Continue — don't block LGPD receipt on log failure
  }

  const webhookLogId: string | null = logInserted?.id ?? null;

  // 6. Resolve internal contact (L-03: null is valid if contact not in CRM)
  const customerId =
    body.customer?.id !== undefined ? String(body.customer.id) : null;
  const customerEmail =
    typeof body.customer?.email === "string" ? body.customer.email : null;

  let contactId: string | null = null;
  if (customerId) {
    const contact = await findContactByExternalId(orgId, customerId, customerEmail);
    contactId = contact?.id ?? null;
  }

  // 7. Build delivery object (method=email; address from payload; null if absent)
  //    Operator resolves via UI if null.
  const delivery: DeliveryInfo | null =
    customerEmail !== null
      ? { method: "email", address: customerEmail }
      : null;

  // 8. Insert lgpd_requests (SLA = 7 BR business days — LGPD Art. 19, L-02)
  const now = new Date();
  let requestId: string;
  let dueAt: string;

  try {
    const result = await createLgpdRequest({
      organizationId: orgId,
      requestType: "customer_data_request",
      source: "nuvemshop",
      contactId,
      externalCustomerId: customerId,
      receivedAt: now,
      slaDays: 7,
      payload: {
        // Store customer object for worker — PII stays here, not in audit log
        customer: body.customer ?? null,
        store_id: storeId,
        orders_requested: body.orders_requested ?? [],
        webhook_log_id: webhookLogId,
        delivery,
        // Non-sensitive headers for traceability
        x_request_id: req.headers.get("x-request-id") ?? null,
      },
    });
    requestId = result.id;
    dueAt = result.due_at;
  } catch (err) {
    console.error(
      `[lgpd-customer-data-request] createLgpdRequest failed: ${(err as Error).message}`,
    );
    return fail("internal_error", "lgpd_request_create_failed", 500);
  }

  // 9. Emit lgpd.data_request_received on event_log for async export-worker (S-08.04)
  const { error: emitErr } = await admin.rpc("emit_event", {
    p_event_type: "lgpd.data_request_received",
    p_entity_kind: "lgpd_request",
    p_entity_id: requestId,
    p_payload: {
      request_id: requestId,
      organization_id: orgId,
      customer_external_id: customerId,
      contact_id: contactId,
      delivery,
      due_at: dueAt,
    } as unknown as Record<string, unknown>,
    p_metadata: { store_id: storeId, due_at: dueAt },
    p_organization_id: orgId,
  });

  if (emitErr) {
    console.error(
      `[lgpd-customer-data-request] emit_event failed: ${emitErr.message}`,
    );
    // Non-blocking — worker can be re-triggered via cron recovery
  }

  // 10. Audit log — ids only, no raw PII
  await audit({
    action: "lgpd.data_request_received",
    organizationId: orgId,
    resourceType: "lgpd_request",
    resourceId: requestId,
    metadata: {
      source: "nuvemshop",
      store_id: storeId,
      external_customer_id: customerId,
      contact_id: contactId,
      delivery_method: delivery?.method ?? null,
      due_at: dueAt,
      webhook_log_id: webhookLogId,
    },
  });

  // 11. Return 200 (Nuvemshop requires 200 within 5s or retries)
  return ok({ received: true, request_id: requestId });
}
