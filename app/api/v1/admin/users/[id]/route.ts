import { type NextRequest } from "next/server";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users/[id]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();

  // Load auth user via admin auth API
  const { data: authUserData, error: authError } =
    await admin.auth.admin.getUserById(id);

  if (authError || !authUserData?.user) {
    return fail("not_found", "User not found", 404, { requestId });
  }

  const authUser = authUserData.user;

  // Load memberships (user_organizations + organizations join)
  const { data: memberships, error: membershipError } = await admin
    .from("user_organizations")
    .select(
      `
      organization_id,
      role,
      accepted_at,
      revoked_at,
      organizations!user_organizations_organization_id_fkey(display_name, slug)
    `,
    )
    .eq("user_id", id)
    .order("accepted_at", { ascending: false });

  if (membershipError) {
    return fail("internal_error", "Membership query failed", 500, {
      requestId,
      details: membershipError.message,
    });
  }

  type RawMembership = {
    organization_id: string;
    role: string;
    accepted_at: string | null;
    revoked_at: string | null;
    organizations: { display_name: string; slug: string } | null;
  };

  const formattedMemberships = ((memberships ?? []) as unknown as RawMembership[]).map(
    (m) => ({
      organization_id: m.organization_id,
      tenant_name: m.organizations?.display_name ?? null,
      tenant_slug: m.organizations?.slug ?? null,
      role: m.role,
      accepted_at: m.accepted_at,
      revoked_at: m.revoked_at,
    }),
  );

  // Load recent audit entries where actor_user_id = id (LIMIT 50)
  const { data: recentAudit, error: auditError } = await admin
    .from("api_audit_log")
    .select(
      "id, action, organization_id, resource_type, resource_id, created_at, metadata",
    )
    .eq("actor_user_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (auditError) {
    // Non-fatal: return empty array and continue
  }

  const userMeta = authUser.user_metadata as Record<string, unknown> | null;

  const userPayload = {
    id: authUser.id,
    email: authUser.email ?? null,
    full_name: (userMeta?.full_name as string | undefined) ?? null,
    phone: authUser.phone ?? null,
    last_sign_in_at: authUser.last_sign_in_at ?? null,
    created_at: authUser.created_at,
    email_confirmed_at: authUser.email_confirmed_at ?? null,
    factors: (authUser.factors ?? []).map((f) => ({
      id: f.id,
      type: f.factor_type,
      status: f.status,
    })),
  };

  void audit({
    action: "platform_admin.user_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "user",
    resourceId: id,
    requestId,
    metadata: {
      email_hash: authUser.email
        ? Buffer.from(authUser.email.toLowerCase()).toString("hex").slice(0, 12) +
          "..."
        : null,
    },
  });

  return ok(
    {
      user: userPayload,
      memberships: formattedMemberships,
      recent_audit: recentAudit ?? [],
    },
    { requestId },
  );
}
