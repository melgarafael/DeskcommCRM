/**
 * GET /api/v1/admin/incidents/[id] (S-11.11)
 *
 * Returns incident detail + tenant info + audit trail.
 * Requires platform admin.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  const { data: incident, error } = await admin
    .from("incidents")
    .select(
      `*, organizations!incidents_organization_id_fkey(id, display_name, slug, status)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !incident) {
    return fail("not_found", "Incident not found", 404, { requestId });
  }

  // Fetch audit trail for this incident via metadata
  const { data: auditTrail } = await admin
    .from("api_audit_log")
    .select(
      "id, action, actor_user_id, created_at, metadata, request_id",
    )
    .contains("metadata", { incident_id: id })
    .order("created_at", { ascending: false })
    .limit(50);

  const org = Array.isArray(incident.organizations)
    ? incident.organizations[0]
    : incident.organizations;

  const shaped = {
    ...incident,
    organizations: undefined,
    tenant: org ?? null,
    audit_trail: auditTrail ?? [],
  };

  void audit({
    action: "platform_admin.incident_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    resourceType: "incident",
    resourceId: id,
    requestId,
    bypassedRls: true,
    metadata: { incident_id: id },
  });

  return ok({ data: shaped }, { requestId });
}
