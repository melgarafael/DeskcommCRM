/**
 * POST /api/v1/admin/tenants/[id]/suspend (S-11.08)
 *
 * Suspends a tenant. Requires platform admin + MFA AAL2.
 * Sets status='suspended', suspended_at=now(), suspended_reason, suspended_by.
 * 404 if tenant not found; 409 if already suspended.
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

  if (org.status === "suspended") {
    return fail("state_conflict", "Tenant is already suspended", 409, { requestId });
  }

  // Perform the UPDATE — service role, filtered by id (no RLS dependency)
  const now = new Date().toISOString();
  const { error: updateError } = await admin
    .from("organizations")
    .update({
      status: "suspended",
      suspended_at: now,
      suspended_reason: body.reason,
      suspended_by: adminCtx.user.id,
      updated_at: now,
    })
    .eq("id", tenantId);

  if (updateError) {
    return fail("internal_error", "Failed to suspend tenant", 500, { requestId });
  }

  // Audit (fire-and-forget)
  void audit({
    action: "tenant.suspended",
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
      suspended_by: adminCtx.user.id,
      reason: body.reason,
    },
  });

  // Domain event for downstream consumers
  void admin.from("event_log").insert({
    organization_id: tenantId,
    entity_kind: "organization",
    entity_id: tenantId,
    event_type: "tenant.suspended",
    payload: {
      tenant_id: tenantId,
      suspended_by: adminCtx.user.id,
      reason: body.reason,
    },
  });

  return ok({ id: tenantId, status: "suspended", suspended_at: now }, { requestId });
}
