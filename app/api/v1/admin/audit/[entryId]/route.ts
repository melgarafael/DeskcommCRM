import { type NextRequest } from "next/server";
import { z } from "zod";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

const paramsSchema = z.object({
  entryId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/audit/[entryId]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const rawParams = await params;
  const parsedParams = paramsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return fail("validation_error", "Invalid entry ID", 400, { requestId });
  }

  const { entryId } = parsedParams.data;
  const admin = createAdminClient();

  // Load the audit entry with tenant info
  const { data: entry, error: entryError } = await admin
    .from("api_audit_log")
    .select(
      `
      id,
      organization_id,
      action,
      actor_user_id,
      resource_type,
      resource_id,
      metadata,
      request_id,
      created_at,
      acting_as_platform_admin,
      bypassed_rls,
      actor_ip,
      actor_user_agent,
      organizations!api_audit_log_organization_id_fkey (
        id,
        display_name,
        slug,
        status
      )
      `,
    )
    .eq("id", entryId)
    .single();

  if (entryError || !entry) {
    return fail("not_found", "Audit entry not found", 404, { requestId });
  }

  // Load actor info from auth.users if actor_user_id present
  let actor: { id: string; email: string | null } | null = null;
  if (entry.actor_user_id) {
    const { data: userData } = await admin.auth.admin.getUserById(entry.actor_user_id);
    if (userData?.user) {
      actor = {
        id: userData.user.id,
        email: userData.user.email ?? null,
      };
    }
  }

  type OrgShape = { id: string; display_name: string; slug: string; status: string };
  const orgRaw = entry.organizations as unknown as OrgShape | OrgShape[] | null;
  const org: OrgShape | null = Array.isArray(orgRaw) ? (orgRaw[0] ?? null) : orgRaw;

  const tenant = org
    ? {
        id: org.id,
        display_name: org.display_name,
        slug: org.slug,
        status: org.status,
      }
    : null;

  // Lightweight audit
  void audit({
    action: "platform_admin.audit_entry_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "audit_entry",
    resourceId: entryId,
    requestId,
    metadata: { viewed_entry_action: entry.action },
  });

  return ok(
    {
      entry: {
        id: entry.id,
        organization_id: entry.organization_id,
        action: entry.action,
        actor_user_id: entry.actor_user_id,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id,
        metadata: entry.metadata,
        request_id: entry.request_id,
        created_at: entry.created_at,
        acting_as_platform_admin: entry.acting_as_platform_admin,
        bypassed_rls: entry.bypassed_rls,
        actor_ip: entry.actor_ip,
        actor_user_agent: entry.actor_user_agent,
      },
      tenant,
      actor,
    },
    { requestId },
  );
}
