/**
 * POST /api/v1/webhooks/nuvemshop/store-redact
 *
 * Receives Nuvemshop `store/redact` LGPD webhook — the "nuclear" webhook
 * emitted when a merchant uninstalls the app. Signals a full tenant redact
 * within 30 days (D+15 SLA per BR business days).
 *
 * Flow (Spec 06 §5.6, CLAUDE.md LGPD rules L-01..L-06):
 *
 *  1. Read raw body for HMAC verification.
 *  2. Parse JSON and extract store_id.
 *  3. Resolve organization_id from tenant_integrations (NOT from body).
 *  4. Decrypt and verify HMAC SHA256 (timingSafeEqual).
 *  5. Idempotency: insert webhook_events_log; skip if duplicate (23505).
 *  6. Count active (non-anonymized) contacts → expected_contacts_count.
 *  7. Insert lgpd_requests (emergency=true, scope='tenant', SLA=15 BR biz days).
 *  8. Emit lgpd.redact_received with tenant-scope payload.
 *  9. Audit log (no PII — store_id + counts only).
 * 10. Return 200 within <5s.
 *
 * NOTE: organizations.status is NOT touched here — flipped by the redact worker
 * (S-08.05) after full cascade confirmation.
 */

import type { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createLgpdRequest } from "@/lib/lgpd/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NuvemshopStoreRedactPayload {
  store_id?: number | string;
  store_name?: string | null;
  /** Optional event id for deduplication. */
  event_id?: string;
  /** App version or identifier. */
  app_version?: string | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// HMAC verification (same pattern as Wave 1 customer-redact)
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
  let body: NuvemshopStoreRedactPayload;
  try {
    body = JSON.parse(rawBody) as NuvemshopStoreRedactPayload;
  } catch {
    return fail("invalid_request", "invalid_json", 400);
  }

  const storeId = body.store_id !== undefined ? String(body.store_id) : "";
  if (!storeId) {
    return fail("invalid_request", "missing store_id", 400);
  }

  const admin = createAdminClient();

  // 3. Resolve organization_id from trusted source (DB lookup by store_id),
  //    never from the request body.
  const { data: integration, error: lookupErr } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, webhook_secret_encrypted")
    .eq("provider", "nuvemshop")
    .eq("store_metadata->>store_id", storeId)
    .maybeSingle();

  if (lookupErr || !integration) {
    console.warn(`[lgpd-store-redact] tenant not found for store_id=${storeId}`);
    return fail("not_found", "integration_not_found", 404);
  }

  const orgId: string = integration.organization_id;

  // 4. Decrypt webhook secret and verify HMAC
  const dec = await admin.rpc("fn_decrypt_oauth", {
    ciphertext: integration.webhook_secret_encrypted,
  });

  if (dec.error || !dec.data) {
    console.error(`[lgpd-store-redact] decrypt failed for org=${orgId}: ${dec.error?.message}`);
    await audit({
      action: "webhook.hmac_invalid",
      organizationId: orgId,
      metadata: { reason: "decrypt_failed", event: "store/redact", store_id: storeId },
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
      metadata: { event: "store/redact", store_id: storeId },
    });
    console.warn(`[lgpd-store-redact] HMAC invalid for org=${orgId} store_id=${storeId}`);
    return fail("unauthenticated", "invalid_signature", 401);
  }

  // 5. Idempotency — webhook_events_log unique (org, provider, event_type, external_id)
  const externalEventId =
    body.event_id ??
    (() => {
      const raw = `store/redact:${storeId}`;
      return createHmac("sha256", clientSecret).update(raw).digest("hex").slice(0, 32);
    })();

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
      event_type: "store/redact",
      external_id: externalEventId,
      status: "received",
      attempts: 0,
    })
    .select("id")
    .single();

  if (logInsertErr) {
    if ((logInsertErr as { code?: string }).code === "23505") {
      return ok({ received: true, idempotent: true });
    }
    console.error(`[lgpd-store-redact] webhook_events_log insert error: ${logInsertErr.message}`);
    // Continue — don't block LGPD receipt on log failure
  }

  const webhookLogId: string | null = logInserted?.id ?? null;

  // 6. Count active (non-anonymized) contacts in the tenant — stored for audit
  //    and forwarded to the worker so it can validate cascade completeness.
  const { count: activeContactsCount, error: countErr } = await admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId) // programmatic tenant filter — service role bypasses RLS
    .eq("is_anonymized", false);

  if (countErr) {
    console.warn(`[lgpd-store-redact] contacts count error for org=${orgId}: ${countErr.message}`);
  }

  const expectedContactsCount = activeContactsCount ?? 0;

  // 7. Insert lgpd_requests (emergency=true, scope='tenant', SLA=15 BR biz days)
  const now = new Date();
  let requestId: string;
  let dueAt: string;

  try {
    const result = await createLgpdRequest({
      organizationId: orgId,
      requestType: "store_redact",
      source: "nuvemshop",
      contactId: null,
      externalCustomerId: null,
      receivedAt: now,
      slaDays: 15,
      emergency: true,
      scope: "tenant",
      payload: {
        store_id: storeId,
        store_name: body.store_name ?? null,
        expected_contacts_count: expectedContactsCount,
        app_version: body.app_version ?? null,
        webhook_log_id: webhookLogId,
        x_request_id: req.headers.get("x-request-id") ?? null,
      },
    });
    requestId = result.id;
    dueAt = result.due_at;
  } catch (err) {
    console.error(`[lgpd-store-redact] createLgpdRequest failed: ${(err as Error).message}`);
    return fail("internal_error", "lgpd_request_create_failed", 500);
  }

  // 8. Emit lgpd.redact_received for async worker (S-08.05)
  const { error: emitErr } = await admin.rpc("emit_event", {
    p_event_type: "lgpd.redact_received",
    p_entity_kind: "lgpd_request",
    p_entity_id: requestId,
    p_payload: {
      request_id: requestId,
      organization_id: orgId,
      scope: "tenant",
      emergency: true,
      expected_contacts_count: expectedContactsCount,
    } as unknown as Record<string, unknown>,
    p_metadata: { store_id: storeId, due_at: dueAt },
    p_organization_id: orgId,
  });

  if (emitErr) {
    console.error(`[lgpd-store-redact] emit_event failed: ${emitErr.message}`);
    // Non-blocking — worker can be re-triggered via cron recovery
  }

  // 9. Audit log — no PII; store_id + counts only
  await audit({
    action: "lgpd.store_redact_received",
    organizationId: orgId,
    resourceType: "lgpd_request",
    resourceId: requestId,
    metadata: {
      source: "nuvemshop",
      store_id: storeId,
      expected_contacts_count: expectedContactsCount,
      due_at: dueAt,
      webhook_log_id: webhookLogId,
    },
  });

  // 10. Return 200 (Nuvemshop requires 200 within 5s or retries)
  return ok({ received: true, request_id: requestId });
}
