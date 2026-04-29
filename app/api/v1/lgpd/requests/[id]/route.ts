/**
 * GET /api/v1/lgpd/requests/[id]
 *
 * Detail of a single lgpd_request + audit trail entries for that request.
 * If completed and result.pdf_path exists, generates a 72h signed URL.
 *
 * Auth: cookie session, role >= admin.
 * organization_id resolved from session — never from body or path.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });
  }

  const isAllowed =
    authUser.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  if (!isAllowed) {
    return fail(
      "forbidden_role",
      "Apenas administradores podem acessar solicitações LGPD.",
      403,
      { requestId },
    );
  }

  const { id } = await params;
  const orgId = activeOrg.orgId;
  const admin = createAdminClient();

  // Fetch the lgpd_request (programmatic org filter — admin client bypasses RLS)
  const { data: request, error: reqErr } = await admin
    .from("lgpd_requests")
    .select(
      "id, organization_id, request_type, source, contact_id, external_customer_id, status, attempts, received_at, due_at, completed_at, emergency, scope, error_message, result, request_payload, created_at, updated_at",
    )
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (reqErr) {
    return fail("internal_error", reqErr.message, 500, { requestId });
  }
  if (!request) {
    return fail("not_found", "Solicitação não encontrada.", 404, { requestId });
  }

  // Fetch audit trail entries for this request
  const { data: auditRows, error: auditErr } = await admin
    .from("api_audit_log")
    .select("id, action, actor_user_id, resource_type, resource_id, metadata, created_at")
    .eq("organization_id", orgId)
    .or(
      `resource_id.eq.${id},metadata->>request_id.eq.${id}`,
    )
    .order("created_at", { ascending: true })
    .limit(50);

  if (auditErr) {
    // Non-fatal — return empty trail
    console.error("[lgpd-request-detail] audit_log fetch error", auditErr.message);
  }

  const audit_trail = auditRows ?? [];

  // Generate signed URL if completed and pdf_path present
  let signed_pdf_url: string | null = null;

  if (request.status === "completed" && request.result) {
    const result = request.result as Record<string, unknown>;
    const pdfPath = typeof result.pdf_path === "string" ? result.pdf_path : null;

    if (pdfPath) {
      const { data: signedData, error: signErr } = await admin.storage
        .from("lgpd-exports")
        .createSignedUrl(pdfPath, 72 * 60 * 60); // 72h in seconds

      if (signErr) {
        console.error("[lgpd-request-detail] signed URL error", signErr.message);
      } else {
        signed_pdf_url = signedData?.signedUrl ?? null;
      }
    }
  }

  return ok(
    { request, audit_trail, signed_pdf_url },
    { requestId },
  );
}
