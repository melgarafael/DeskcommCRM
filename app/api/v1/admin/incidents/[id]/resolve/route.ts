/**
 * POST /api/v1/admin/incidents/[id]/resolve (S-11.11)
 *
 * Resolves an incident. Requires platform admin.
 * Body: { resolution_note: string (≥10 chars) }
 * 404 if not found; 409 if already resolved.
 * Audits incident.resolved + emits event_log domain event.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

const bodySchema = z.object({
  resolution_note: z
    .string()
    .min(10, "Nota de resolução deve ter ao menos 10 caracteres")
    .max(1000, "Nota de resolução deve ter no máximo 1000 caracteres"),
});

export async function POST(
  req: NextRequest,
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

  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await req.json();
    body = bodySchema.parse(raw);
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: incident, error: loadError } = await admin
    .from("incidents")
    .select("id, status, organization_id, type, severity")
    .eq("id", id)
    .maybeSingle();

  if (loadError || !incident) {
    return fail("not_found", "Incident not found", 404, { requestId });
  }

  if (incident.status === "resolved") {
    return fail("state_conflict", "Incident is already resolved", 409, { requestId });
  }

  const now = new Date().toISOString();

  const { error: updateError } = await admin
    .from("incidents")
    .update({
      status: "resolved",
      resolved_at: now,
      resolved_by: adminCtx.user.id,
      resolution_note: body.resolution_note,
      updated_at: now,
    })
    .eq("id", id);

  if (updateError) {
    return fail("internal_error", "Failed to resolve incident", 500, { requestId });
  }

  // Audit log (fire-and-forget)
  void audit({
    action: "incident.resolved",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    organizationId: incident.organization_id,
    resourceType: "incident",
    resourceId: id,
    requestId,
    bypassedRls: true,
    metadata: {
      incident_id: id,
      tenant_id: incident.organization_id,
      incident_type: incident.type,
      incident_severity: incident.severity,
      resolution_note: body.resolution_note,
    },
  });

  // Domain event (fire-and-forget)
  void admin.from("event_log").insert({
    organization_id: incident.organization_id,
    entity_kind: "incident",
    entity_id: id,
    event_type: "incident.resolved",
    payload: {
      incident_id: id,
      resolved_by: adminCtx.user.id,
      tenant_id: incident.organization_id,
      incident_type: incident.type,
      incident_severity: incident.severity,
    },
  });

  return ok({ data: { id, status: "resolved" } }, { requestId });
}
