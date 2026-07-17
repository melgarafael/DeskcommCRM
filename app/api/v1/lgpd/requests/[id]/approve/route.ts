/**
 * POST /api/v1/lgpd/requests/[id]/approve
 *
 * Manually approves an LGPD request that is in 'received' status.
 * Emits the canonical event to event_log (same as the webhook handler),
 * writes audit lgpd.manually_approved, and transitions status → 'processing'.
 *
 * Auth: cookie session, role >= admin.
 * Idempotency-Key header is REQUIRED. Returns 202 on success.
 */
import { randomUUID, createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  approved_reason: z.string().min(10).max(500),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "lgpd_requests",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  // Idempotency-Key is required
  const idempotencyKey =
    req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return fail(
      "missing_idempotency_key",
      "Header Idempotency-Key é obrigatório.",
      422,
      { requestId },
    );
  }

  const { id } = await params;
  const orgId = activeOrg.orgId;
  const admin = createAdminClient();

  // Parse body
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Parâmetros inválidos.", 422, {
      details: parsed.error.flatten(),
      requestId,
    });
  }

  const { approved_reason } = parsed.data;

  // Idempotency check — endpoint is /lgpd/requests/:id/approve
  const endpoint = `/api/v1/lgpd/requests/${id}/approve`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ id, approved_reason }))
    .digest("hex");

  const { data: existingKey, error: keyLookupErr } = await admin
    .from("idempotency_keys")
    .select("id, response_body, status_code")
    .eq("organization_id", orgId)
    .eq("key", idempotencyKey)
    .eq("endpoint", endpoint)
    .maybeSingle();

  if (keyLookupErr) {
    console.error("[lgpd-approve] idempotency lookup error", keyLookupErr.message);
  }

  if (existingKey) {
    // Return cached result
    const body = existingKey.response_body as Record<string, unknown>;
    return ok(body, {
      requestId,
      status: existingKey.status_code === 202 ? 200 : 200,
    });
  }

  // Fetch the lgpd_request
  const { data: request, error: reqErr } = await admin
    .from("lgpd_requests")
    .select("id, organization_id, request_type, status, contact_id, external_customer_id, due_at")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (reqErr) {
    return fail("internal_error", reqErr.message, 500, { requestId });
  }
  if (!request) {
    return fail("not_found", "Solicitação não encontrada.", 404, { requestId });
  }

  // Only 'received' can be approved
  if (request.status !== "received") {
    return fail(
      "conflict",
      `Solicitação está em status '${request.status}' — apenas 'received' pode ser aprovada.`,
      409,
      { requestId },
    );
  }

  // Determine event type based on request_type
  const eventType =
    request.request_type === "customer_data_request"
      ? "lgpd.data_request_received"
      : "lgpd.redact_received";

  // Emit event to event_log (triggers async worker)
  const { error: emitErr } = await admin.rpc("emit_event", {
    p_event_type: eventType,
    p_entity_kind: "lgpd_request",
    p_entity_id: id,
    p_payload: {
      request_id: id,
      organization_id: orgId,
      manually_approved: true,
      approved_by: authUser.id,
      approved_reason,
      contact_id: request.contact_id,
      external_customer_id: request.external_customer_id,
      due_at: request.due_at,
    } as unknown as Record<string, unknown>,
    p_metadata: {
      manually_approved: true,
      idempotency_key: idempotencyKey,
    },
    p_organization_id: orgId,
  });

  if (emitErr) {
    console.error("[lgpd-approve] emit_event failed", emitErr.message);
    // Non-blocking — worker can recover via cron
  }

  // Transition status → processing
  const { error: updateErr } = await admin
    .from("lgpd_requests")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", id);

  if (updateErr) {
    return fail("internal_error", updateErr.message, 500, { requestId });
  }

  // Audit — fire-and-forget
  void audit({
    action: "lgpd.manually_approved",
    actorUserId: authUser.id,
    organizationId: orgId,
    resourceType: "lgpd_request",
    resourceId: id,
    requestId,
    metadata: {
      approved_reason,
      idempotency_key: idempotencyKey,
      request_type: request.request_type,
    },
  });

  const responseBody = { request_id: id, status: "processing" };

  // Store idempotency result
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await admin
    .from("idempotency_keys")
    .insert({
      organization_id: orgId,
      key: idempotencyKey,
      endpoint,
      request_hash: requestHash,
      response_body: responseBody as unknown as Record<string, unknown>,
      status_code: 202,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  return ok(responseBody, { requestId, status: 200 });
}
