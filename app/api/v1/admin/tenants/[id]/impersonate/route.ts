/**
 * POST /api/v1/admin/tenants/[id]/impersonate (S-11.07)
 *
 * Starts a platform-admin impersonation session for a tenant. Issues a signed
 * `deskcomm-impersonate` cookie (HMAC-SHA256, 1h TTL, HttpOnly+Secure+Lax).
 * Audits start + emits cross-tenant `event_log` row.
 *
 * Security:
 *  - requirePlatformAdmin enforces auth + MFA AAL2 + active platform_admins row
 *  - Cookie is opaque to the client (HttpOnly); only middleware/server can read
 *  - 503 returned if `IMPERSONATE_COOKIE_SECRET` not configured
 *  - Cookie is additive — the platform admin's actual Supabase session is
 *    untouched; downstream code reads the cookie to add tenant-scope to queries
 */
import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import {
  IMPERSONATE_COOKIE_NAME,
  IMPERSONATE_TTL_SECONDS,
  isImpersonateSecretReady,
  signImpersonateCookie,
} from "@/lib/impersonate/cookie";

export async function POST(
  _req: NextRequest,
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

  // Misconfiguration guard — refuse to mint cookies we can't verify later.
  if (!isImpersonateSecretReady()) {
    void audit({
      action: "platform_admin.impersonate_misconfigured",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: tenantId,
      resourceType: "organization",
      resourceId: tenantId,
      requestId,
      metadata: { reason: "secret_missing_or_short" },
    });
    return fail(
      "upstream_unavailable",
      "Impersonate flow is not configured on this environment",
      503,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, slug, display_name, status")
    .eq("id", tenantId)
    .maybeSingle();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }
  if (org.status === "redacted") {
    return fail(
      "state_conflict",
      "Cannot impersonate a redacted tenant",
      409,
      { requestId },
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + IMPERSONATE_TTL_SECONDS;
  const token = signImpersonateCookie({
    tenantId: org.id,
    platformAdminId: adminCtx.user.id,
    exp,
  });

  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    maxAge: IMPERSONATE_TTL_SECONDS,
    path: "/",
  });

  // Audit start (acting_as_platform_admin=true is the tell-tale signal).
  void audit({
    action: "platform_admin.impersonate_started",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    requestId,
    metadata: {
      tenant_id: org.id,
      tenant_slug: org.slug,
      platform_admin_id: adminCtx.user.id,
      exp,
    },
  });

  // Emit a cross-tenant domain event for downstream consumers (e.g. SIEM,
  // anomaly detection). Service-role admin bypasses RLS — this is intentional.
  await admin.from("event_log").insert({
    organization_id: org.id,
    entity_kind: "platform_admin_session",
    entity_id: adminCtx.user.id,
    event_type: "platform_admin.impersonate_started",
    payload: {
      tenant_id: org.id,
      platform_admin_id: adminCtx.user.id,
      exp,
    },
  });

  return ok(
    {
      redirect_url: "/app/inbox",
      tenant: {
        id: org.id,
        slug: org.slug,
        display_name: org.display_name,
      },
      expires_at: new Date(exp * 1000).toISOString(),
    },
    { requestId },
  );
}
