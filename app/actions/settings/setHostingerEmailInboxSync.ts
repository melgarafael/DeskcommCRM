"use server";

import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createHostingerInboxCursor } from "@/lib/email/hostinger";
import { getHostingerEmailAccountForHealth } from "@/lib/email/hostinger-config";

export type SetHostingerEmailInboxSyncResult =
  | { ok: true; enabled: boolean }
  | {
      ok: false;
      error: "validation_failed" | "unauthenticated" | "forbidden" | "mfa_required" | "connection_unavailable" | "database_error";
    };

/** Audited opt-in for reading the connected inbox into the shared CRM Inbox. */
export async function setHostingerEmailInboxSyncEnabled(
  value: unknown,
): Promise<SetHostingerEmailInboxSyncResult> {
  if (typeof value !== "boolean") return { ok: false, error: "validation_failed" };
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const org = await resolveActiveOrg(user);
  if (!org || !podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: current, error: readError } = await admin
    .from("organization_email_connections")
    .select("id,status,inbox_sync_enabled,inbox_uid_validity,inbox_last_uid")
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (readError) return { ok: false, error: "database_error" };
  if (!current || (value && current.status !== "healthy")) {
    return { ok: false, error: "connection_unavailable" };
  }
  if (current.inbox_sync_enabled === value) return { ok: true, enabled: value };

  let startCursor: { uidValidity: string; lastUid: number } | null = null;
  if (value) {
    // Snapshot the newest UID at the moment the admin opts in. A mailbox that
    // was connected earlier must not import the messages that arrived while
    // synchronization was off.
    const account = await getHostingerEmailAccountForHealth(org.orgId);
    if (account.state !== "ready") return { ok: false, error: "connection_unavailable" };
    startCursor = await createHostingerInboxCursor(account.credentials);
    if (!startCursor) return { ok: false, error: "connection_unavailable" };
  }

  const update = admin
    .from("organization_email_connections")
    .update({
      inbox_sync_enabled: value,
      ...(startCursor ? {
        inbox_uid_validity: startCursor.uidValidity,
        inbox_last_uid: startCursor.lastUid,
        last_error_code: null,
        last_sync_at: new Date().toISOString(),
      } : {}),
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", current.id)
    .eq("organization_id", org.orgId)
    .eq("inbox_sync_enabled", current.inbox_sync_enabled);
  const { data, error } = await (value ? update.eq("status", "healthy") : update)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: "database_error" };
  if (!data) return { ok: false, error: "connection_unavailable" };

  await audit({
    action: value ? "email.inbox_sync_enabled" : "email.inbox_sync_disabled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization_email_connection",
    resourceId: data.id,
    metadata: { provider: "hostinger", enabled: value, initial_history_import: false },
  });
  revalidatePath("/app/settings/email");
  return { ok: true, enabled: value };
}
