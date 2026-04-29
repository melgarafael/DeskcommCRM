/**
 * Server guard for /admin/* (Super-Admin Platform sub-product).
 *
 * Flow:
 *  1. Validate JWT via getUser() (NEVER getSession on backend per CLAUDE.md).
 *  2. Confirm row in platform_admins (active = no revoked_at).
 *  3. Enforce MFA AAL2 if `mfa_required` (default true for platform admins).
 *
 * Redirects:
 *  - no user        → /login?next=/admin
 *  - no row         → /admin/forbidden
 *  - aal1 + required → /login/mfa?next=/admin
 *
 * The middleware already does an early `fn_is_platform_admin` RPC check;
 * this helper performs the authoritative server-side validation inside the
 * /admin layout (where redirects are cheap, DB calls are allowed in Node
 * runtime, and we have access to AAL state).
 */
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export interface PlatformAdminInfo {
  user_id: string;
  scope: string;
  mfa_required: boolean;
}

export interface PlatformAdminContext {
  user: User;
  platformAdmin: PlatformAdminInfo;
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/admin");
  }

  // platform_admins RLS: only platform admins read; non-admins get null → forbid.
  const { data: paRow } = await supabase
    .from("platform_admins")
    .select("user_id, scope, mfa_required, revoked_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  if (!paRow) {
    redirect("/admin/forbidden");
  }

  if (paRow.mfa_required) {
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData?.currentLevel !== "aal2") {
      redirect("/login/mfa?next=/admin");
    }
  }

  return {
    user,
    platformAdmin: {
      user_id: paRow.user_id,
      scope: paRow.scope,
      mfa_required: paRow.mfa_required,
    },
  };
}
