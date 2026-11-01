/**
 * GET /api/v1/admin/lgpd/requests/[id]
 *
 * Detail of a single lgpd_request cross-tenant — platform admin only.
 * Service-role client (bypasses RLS).
 * Returns: request + tenant info + audit_trail.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId, "Platform admin required.");
  }

  const { id } = await params;
  const admin = createAdminClient();

  // Fetch lgpd_request (no org filter — cross-tenant intentional)
  const { data: request, error: reqErr } = await admin
    .from("lgpd_requests")
    .select(
      "id, organization_id, request_type, source, contact_id, external_customer_id, status, attempts, received_at, due_at, completed_at, emergency, scope, error_message, result, request_payload, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (reqErr) {
    return fail("internal_error", reqErr.message, 500, { requestId });
  }
  if (!request) {
    return fail("not_found", "Solicitação não encontrada.", 404, { requestId });
  }

  // Fetch tenant info
  const { data: org } = await admin
    .from("organizations")
    .select("id, display_name, slug, status")
    .eq("id", request.organization_id)
    .maybeSingle();

  // Fetch audit trail for this request (cross-tenant)
  const { data: auditRows, error: auditErr } = await admin
    .from("api_audit_log")
    .select("id, action, actor_user_id, resource_type, resource_id, metadata, created_at")
    .or(`resource_id.eq.${id},metadata->>request_id.eq.${id}`)
    .order("created_at", { ascending: true })
    .limit(50);

  if (auditErr) {
    // Non-fatal — empty trail
    console.error("[admin-lgpd-request-detail] audit fetch error", auditErr.message);
  }

  // Audit — fire and forget
  void audit({
    action: "platform_admin.lgpd_request_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "lgpd_request",
    resourceId: id,
    requestId,
    metadata: { organization_id: request.organization_id },
  });

  return ok(
    {
      request,
      tenant: org ?? null,
      audit_trail: auditRows ?? [],
    },
    { requestId },
  );
}
