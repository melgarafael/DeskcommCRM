"use server";

import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type SetHostingerEmailAutomationResult =
  | { ok: true; enabled: boolean }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden"
        | "mfa_required"
        | "connection_unavailable"
        | "database_error";
    };

/** Explicit, audited opt-in for using the company's mailbox in automations. */
export async function setHostingerEmailAutomationEnabled(
  value: unknown,
): Promise<SetHostingerEmailAutomationResult> {
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
    .select("id,status,outbound_automation_enabled")
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (readError) return { ok: false, error: "database_error" };
  if (!current || (value && current.status !== "healthy")) {
    return { ok: false, error: "connection_unavailable" };
  }

  if (current.outbound_automation_enabled === value) return { ok: true, enabled: value };

  const updateQuery = admin
    .from("organization_email_connections")
    .update({
      outbound_automation_enabled: value,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", current.id)
    .eq("organization_id", org.orgId);
  const { data: updated, error: updateError } = await (value
    ? updateQuery.eq("status", "healthy")
    : updateQuery)
    .select("id")
    .maybeSingle();
  if (updateError) return { ok: false, error: "database_error" };
  if (!updated) return { ok: false, error: "connection_unavailable" };

  await audit({
    action: value ? "email.automation_sending_enabled" : "email.automation_sending_disabled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization_email_connection",
    resourceId: updated.id,
    metadata: { provider: "hostinger", enabled: value },
  });
  revalidatePath("/app/settings/email");
  return { ok: true, enabled: value };
}
