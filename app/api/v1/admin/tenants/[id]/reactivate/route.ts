/**
 * POST /api/v1/admin/tenants/[id]/reactivate (S-11.08)
 *
 * Reactivates a suspended tenant. Requires platform admin + MFA AAL2.
 * Clears status back to 'active', nulls suspended_at/reason/by.
 * 404 if tenant not found; 409 if not in 'suspended' state.
 * Emits audit + event_log domain event.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

const bodySchema = z.object({
  reason: z
    .string()
    .min(10, "Motivo deve ter ao menos 10 caracteres")
    .max(500, "Motivo deve ter no máximo 500 caracteres"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id: tenantId } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  // Validate body
  let body: z.infer<typeof bodySchema>;
  try {
    const raw = await req.json();
    body = bodySchema.parse(raw);
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();

  // Load tenant — service role bypasses RLS intentionally
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug, display_name, status")
    .eq("id", tenantId)
    .maybeSingle();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  if (org.status !== "suspended") {
    return fail(
      "state_conflict",
      "Tenant is not suspended — cannot reactivate",
      409,
      { requestId },
    );
  }

  // Perform the UPDATE — clear all suspension fields
  const now = new Date().toISOString();
  const { error: updateError } = await admin
    .from("organizations")
    .update({
      status: "active",
      suspended_at: null,
      suspended_reason: null,
      suspended_by: null,
      updated_at: now,
    })
    .eq("id", tenantId);

  if (updateError) {
    return fail("internal_error", "Failed to reactivate tenant", 500, { requestId });
  }

  // Audit (fire-and-forget)
  void audit({
    action: "tenant.reactivated",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: tenantId,
    resourceType: "organization",
    resourceId: tenantId,
    requestId,
    metadata: {
      tenant_id: tenantId,
      tenant_slug: org.slug,
      reactivated_by: adminCtx.user.id,
      reason: body.reason,
    },
  });

  // Domain event
  void admin.from("event_log").insert({
    organization_id: tenantId,
    entity_kind: "organization",
    entity_id: tenantId,
    event_type: "tenant.reactivated",
    payload: {
      tenant_id: tenantId,
      reactivated_by: adminCtx.user.id,
      reason: body.reason,
    },
  });

  return ok({ id: tenantId, status: "active" }, { requestId });
}
