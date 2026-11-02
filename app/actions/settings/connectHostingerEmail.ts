"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { saveHostingerEmailConnection } from "@/lib/email/hostinger-config";

const schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1_024).refine((value) => value.trim().length > 0),
});

export type ConnectHostingerEmailResult =
  | { ok: true; email: string; inboxSyncEnabled: boolean; outboundAutomationEnabled: boolean }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden"
        | "mfa_required"
        | "authentication_failed"
        | "connection_failed"
        | "mailbox_unavailable"
        | "encryption_unavailable"
        | "database_error";
    };

export async function connectHostingerEmail(
  input: unknown,
): Promise<ConnectHostingerEmailResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const org = await resolveActiveOrg(user);
  if (!org || !podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  let result: Awaited<ReturnType<typeof saveHostingerEmailConnection>>;
  try {
    result = await saveHostingerEmailConnection(org.orgId, user.id, {
      email: parsed.data.email,
      password: parsed.data.password,
    });
  } catch {
    return { ok: false, error: "database_error" };
  }
  if (!result.ok) return result;

  await audit({
    action: "channel.connected",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "organization_email_connection",
    resourceId: result.connection.id,
    metadata: {
      provider: "hostinger",
      imap_verified: true,
      smtp_verified: true,
      inbox_sync_enabled: result.connection.inbox_sync_enabled,
    },
  });
  revalidatePath("/app/settings/email");

  return {
    ok: true,
    email: result.connection.mailbox_email,
    inboxSyncEnabled: result.connection.inbox_sync_enabled,
    outboundAutomationEnabled: result.connection.outbound_automation_enabled,
  };
}
