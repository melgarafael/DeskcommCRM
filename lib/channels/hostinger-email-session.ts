import "server-only";

import { randomUUID } from "node:crypto";

import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

type Admin = ReturnType<typeof createAdminClient>;

/** Creates or reactivates the channel session through the channel seam. */
export async function ensureHostingerEmailChannelSession(
  admin: Admin,
  input: { organizationId: string; connectionId: string; mailboxEmail: string; actorUserId: string },
): Promise<boolean> {
  const sessionRef = `email:${input.connectionId}`;
  const metadata = { channel_kind: "email", email_connection_id: input.connectionId };
  const { data: existing, error: readError } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("provider", "hostinger_email")
    .maybeSingle();
  if (readError) {
    logger.error("[email.hostinger] falha ao ler sessão do canal", { code: readError.code });
    return false;
  }
  if (existing) {
    const { error } = await admin
      .from("channel_sessions")
      .update({
        waha_session_name: sessionRef,
        display_name: input.mailboxEmail,
        status: "WORKING",
        status_reason: null,
        metadata,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", existing.id);
    if (error) {
      logger.error("[email.hostinger] falha ao reativar sessão do canal", { code: error.code });
      return false;
    }
    return true;
  }

  const encryptedPlaceholder = await encryptWebhookSecret(admin, randomUUID());
  if (!encryptedPlaceholder) return false;
  const { error } = await admin.from("channel_sessions").insert({
    organization_id: input.organizationId,
    provider: "hostinger_email",
    waha_session_name: sessionRef,
    display_name: input.mailboxEmail,
    status: "WORKING",
    status_reason: null,
    webhook_secret_encrypted: encryptedPlaceholder,
    metadata,
    created_by: input.actorUserId,
  });
  if (error) {
    logger.error("[email.hostinger] falha ao criar sessão do canal", { code: error.code });
    return false;
  }
  return true;
}
