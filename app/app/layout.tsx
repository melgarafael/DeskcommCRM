import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isMfaEnrolled, loadAuthUser, requiresMfa, resolveActiveOrg } from "@/lib/auth/server";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { AppShell } from "./_components/AppShell";
import { MfaEnrollGate } from "@/components/auth/MfaEnrollGate";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  IMPERSONATE_COOKIE_NAME,
  verifyImpersonateCookie,
} from "@/lib/impersonate/cookie";
import {
  ImpersonateBanner,
  type ImpersonatingInfo,
} from "@/components/app/ImpersonateBanner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await loadAuthUser();
  if (!user) redirect("/login");

  const activeOrg = await resolveActiveOrg(user);

  // EPIC-02: gate /app/* on completed onboarding.
  // EPIC-11: gate /app/* on org not being suspended (S-11.08).
  if (activeOrg) {
    const admin = createAdminClient();
    const { data: orgRow } = await admin
      .from("organizations")
      .select("onboarded_at, status")
      .eq("id", activeOrg.orgId)
      .maybeSingle();
    if (orgRow && !orgRow.onboarded_at) redirect("/onboarding");
    if (orgRow?.status === "suspended") redirect("/account-suspended");
  }

  // Read sidebar collapsed state SSR to avoid flash.
  const store = await cookies();
  const collapsed = store.get("sidebar_collapsed")?.value === "1";

  // Impersonate (S-11.07): verify cookie server-side and resolve tenant name.
  // Middleware already validates HMAC + expiry on /app/*; we re-verify here as
  // defence-in-depth and to extract the payload safely.
  let impersonating: ImpersonatingInfo | null = null;
  const impCookie = store.get(IMPERSONATE_COOKIE_NAME)?.value;
  if (impCookie) {
    const result = verifyImpersonateCookie(impCookie);
    if (result.valid && result.payload) {
      const admin = createAdminClient();
      const { data: org } = await admin
        .from("organizations")
        .select("display_name")
        .eq("id", result.payload.tenantId)
        .maybeSingle();
      if (org) {
        impersonating = {
          tenantId: result.payload.tenantId,
          tenantName: org.display_name,
          expiresAt: new Date(result.payload.exp * 1000).toISOString(),
        };
      }
    }
  }

  const enrolled = await isMfaEnrolled();
  const mustEnroll = requiresMfa(activeOrg?.role, user.is_platform_admin) && !enrolled;

  return (
    <AuthProvider user={user} activeOrg={activeOrg}>
      <ImpersonateBanner impersonating={impersonating} />
      {mustEnroll ? <MfaEnrollGate /> : <AppShell sidebarCollapsed={collapsed}>{children}</AppShell>}
    </AuthProvider>
  );
}
