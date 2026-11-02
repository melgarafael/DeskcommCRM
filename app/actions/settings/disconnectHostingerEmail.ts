"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type DisconnectHostingerEmailResult =
  | { ok: true }
  | {
      ok: false;
      error: "unauthenticated" | "forbidden" | "mfa_required" | "database_error";
    };

/** Removes the encrypted mailbox credential and disables any future inbox polling. */
export async function disconnectHostingerEmail(): Promise<DisconnectHostingerEmailResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const org = await resolveActiveOrg(user);
  if (!org || !podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("organization_email_connections")
    .select("id")
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (connectionError) return { ok: false, error: "database_error" };

  if (connection) {
    const { error: sessionError } = await admin
      .from("channel_sessions")
      .update({ status: "STOPPED", status_reason: "email_connection_disconnected" })
      .eq("organization_id", org.orgId)
      .eq("provider", "hostinger_email")
      .eq("metadata->>email_connection_id", connection.id);
    if (sessionError) return { ok: false, error: "database_error" };
  }

  const { data, error } = await admin
    .from("organization_email_connections")
    .delete()
    .eq("organization_id", org.orgId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: "database_error" };

  if (data) {
    const requestHeaders = await headers();
    await audit({
      action: "email.connection_disconnected",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "organization_email_connection",
      resourceId: data.id,
      requestId: requestHeaders.get("x-request-id") ?? undefined,
      ip: ipDoCliente(requestHeaders) ?? undefined,
      userAgent: requestHeaders.get("user-agent") ?? undefined,
      metadata: { provider: "hostinger", credential_removed: true },
    });
  }

  revalidatePath("/app/settings/email");
  return { ok: true };
}
