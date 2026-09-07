"use server";

/**
 * Server Action: mark the active org's Nuvemshop integration as disconnected.
 *
 * MVP scope: flips `status='disconnected'`, clears tokens, and audits. Webhook
 * cleanup on Nuvemshop's side is best-effort (deferred to a worker because we
 * may not have a valid token if the disconnect was triggered by token expiry).
 */

import { supportWriteError } from "@/lib/impersonate/support";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type DisconnectResult =
  | { ok: true }
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | "not_connected" | "db_error" };

export async function disconnectNuvemshop(): Promise<DisconnectResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };

  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };

  if (activeOrg.role !== "admin" && !user.is_platform_admin) {
    return { ok: false, error: "forbidden" };
  }

  const admin = createAdminClient();
  const { data: existing, error: lookupErr } = await admin
    .from("tenant_integrations")
    .select("id")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "nuvemshop")
    .maybeSingle();

  if (lookupErr) return { ok: false, error: "db_error" };
  if (!existing) return { ok: false, error: "not_connected" };

  const { error: updErr } = await admin
    .from("tenant_integrations")
    .update({
      status: "disconnected",
      status_reason: "user_disconnected",
    })
    .eq("id", existing.id);

  if (updErr) return { ok: false, error: "db_error" };

  await audit({
    action: "nuvemshop.disconnected",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    resourceType: "tenant_integration",
    resourceId: existing.id,
  });

  revalidatePath("/app/integrations/nuvemshop");
  return { ok: true };
}
