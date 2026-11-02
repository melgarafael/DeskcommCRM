import "server-only";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { ensureHostingerEmailChannelSession } from "@/lib/channels/hostinger-email-session";
import {
  checkHostingerEmailAccess,
  createHostingerInboxCursor,
  type HostingerEmailAccessCheck,
  type HostingerEmailCredentials,
} from "@/lib/email/hostinger";

export interface HostingerEmailConnectionSummary {
  id: string;
  organization_id: string;
  mailbox_email: string;
  status: "disconnected" | "healthy" | "error";
  outbound_automation_enabled: boolean;
  inbox_sync_enabled: boolean;
  inbox_uid_validity: string | null;
  inbox_last_uid: number;
  last_sync_at: string | null;
  last_error_code: string | null;
  updated_at: string;
}

const SUMMARY_COLUMNS =
  "id,organization_id,mailbox_email,status,outbound_automation_enabled,inbox_sync_enabled,inbox_uid_validity,inbox_last_uid,last_sync_at,last_error_code,updated_at";

export async function getHostingerEmailConnection(
  organizationId: string,
): Promise<
  | { ok: true; connection: HostingerEmailConnectionSummary | null }
  | { ok: false }
> {
  const { data, error } = await createAdminClient()
    .from("organization_email_connections")
    .select(SUMMARY_COLUMNS)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    logger.error("[email.hostinger] falha ao ler estado da conexão", { code: error.code });
    return { ok: false };
  }
  return { ok: true, connection: (data as HostingerEmailConnectionSummary | null) ?? null };
}

export type SaveHostingerEmailConnectionResult =
  | {
      ok: true;
      connection: HostingerEmailConnectionSummary;
      access: HostingerEmailAccessCheck;
    }
  | {
      ok: false;
      error:
        | "authentication_failed"
        | "connection_failed"
        | "mailbox_unavailable"
        | "encryption_unavailable"
        | "database_error";
      access?: HostingerEmailAccessCheck;
    };

/** Verifies both protocols before storing the mailbox password encrypted. */
export async function saveHostingerEmailConnection(
  organizationId: string,
  actorUserId: string,
  credentials: HostingerEmailCredentials,
): Promise<SaveHostingerEmailConnectionResult> {
  const admin = createAdminClient();
  const normalizedEmail = credentials.email.trim().toLowerCase();
  const { data: currentData, error: currentError } = await admin
    .from("organization_email_connections")
    .select("id,mailbox_email,outbound_automation_enabled,inbox_sync_enabled,inbox_uid_validity,inbox_last_uid")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (currentError) {
    logger.error("[email.hostinger] falha ao ler configuração anterior", { code: currentError.code });
    return { ok: false, error: "database_error" };
  }

  const access = await checkHostingerEmailAccess(credentials);
  if (!access.ready) {
    const failure = access.incoming !== "connected" ? access.incoming : access.outgoing;
    return {
      ok: false,
      error:
        failure === "authentication_failed"
          ? "authentication_failed"
          : failure === "mailbox_unavailable"
            ? "mailbox_unavailable"
            : "connection_failed",
      access,
    };
  }

  const current = currentData as {
    id: string;
    mailbox_email: string;
    outbound_automation_enabled: boolean;
    inbox_sync_enabled: boolean;
    inbox_uid_validity: string | null;
    inbox_last_uid: number | string;
  } | null;
  const mesmaCaixa = current?.mailbox_email.trim().toLowerCase() === normalizedEmail;
  let cursor = mesmaCaixa && current?.inbox_uid_validity
    ? {
        uidValidity: current.inbox_uid_validity,
        lastUid: Number(current.inbox_last_uid),
      }
    : null;
  if (!cursor || !Number.isSafeInteger(cursor.lastUid) || cursor.lastUid < 0) {
    cursor = await createHostingerInboxCursor(credentials);
  }
  if (!cursor) return { ok: false, error: "mailbox_unavailable", access };

  const encrypted = await encryptWebhookSecret(admin, credentials.password);
  if (!encrypted) return { ok: false, error: "encryption_unavailable", access };

  const { data, error } = await admin
    .from("organization_email_connections")
    .upsert(
      {
        ...(current ? { id: current.id } : {}),
        organization_id: organizationId,
        provider: "hostinger",
        mailbox_email: normalizedEmail,
        mailbox_password_encrypted: encrypted,
        status: "healthy",
        outbound_automation_enabled: mesmaCaixa
          ? current?.outbound_automation_enabled ?? false
          : false,
        // Trocar de caixa nunca herda a autorização de sincronização da
        // anterior. Além de evitar importar uma caixa pessoal por engano, isso
        // mantém o cursor e o indicador de última sincronização coerentes com
        // a identidade que acabou de ser conectada.
        inbox_sync_enabled: mesmaCaixa ? current?.inbox_sync_enabled ?? false : false,
        inbox_uid_validity: cursor.uidValidity,
        inbox_last_uid: cursor.lastUid,
        ...(mesmaCaixa ? {} : { last_sync_at: null }),
        last_error_code: null,
        ...(current ? {} : { created_by: actorUserId }),
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    )
    .select(SUMMARY_COLUMNS)
    .single();

  if (error || !data) {
    logger.error("[email.hostinger] falha ao salvar conexão", { code: error?.code ?? "empty" });
    return { ok: false, error: "database_error", access };
  }

  const sessionReady = await ensureHostingerEmailChannelSession(admin, {
    organizationId,
    connectionId: (data as HostingerEmailConnectionSummary).id,
    mailboxEmail: normalizedEmail,
    actorUserId,
  });
  if (!sessionReady) return { ok: false, error: "database_error", access };

  return { ok: true, connection: data as HostingerEmailConnectionSummary, access };
}

/** The only worker-facing read path; callers must already have the org id. */
export async function getHostingerEmailCredentials(
  organizationId: string,
): Promise<HostingerEmailCredentials | null> {
  const { data, error } = await createAdminClient()
    .from("organization_email_connections")
    .select("mailbox_email,mailbox_password_encrypted,status")
    .eq("organization_id", organizationId)
    .eq("status", "healthy")
    .eq("inbox_sync_enabled", true)
    .maybeSingle();
  if (error || !data) {
    if (error) logger.error("[email.hostinger] falha ao ler credencial para worker", { code: error.code });
    return null;
  }
  const row = data as { mailbox_email: string; mailbox_password_encrypted: string };
  const password = await decryptWebhookSecret(createAdminClient(), row.mailbox_password_encrypted);
  return password ? { email: row.mailbox_email, password } : null;
}

/** Health checks can verify a connected mailbox even while inbox polling is paused. */
export async function getHostingerEmailAccountForHealth(
  organizationId: string,
): Promise<HostingerEmailSendingAccount> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("organization_email_connections")
      .select("mailbox_email,mailbox_password_encrypted,status")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error) {
      logger.error("[email.hostinger] falha ao consultar caixa para saúde", { code: error.code });
      return { state: "unavailable" };
    }
    if (!data) return { state: "unconfigured" };
    const row = data as { mailbox_email: string; mailbox_password_encrypted: string; status: string };
    if (row.status !== "healthy") return { state: "unavailable" };
    const password = await decryptWebhookSecret(admin, row.mailbox_password_encrypted);
    return password
      ? { state: "ready", credentials: { email: row.mailbox_email, password } }
      : { state: "unavailable" };
  } catch {
    logger.error("[email.hostinger] falha ao carregar caixa para saúde", { organizationId });
    return { state: "unavailable" };
  }
}

export type HostingerEmailSendingAccount =
  | { state: "unconfigured" }
  | { state: "unavailable" }
  | { state: "ready"; credentials: HostingerEmailCredentials };

/** Account used by the conversation channel; automatic replies honor the same opt-in as automations. */
export async function getHostingerEmailAccountForChannel(
  organizationId: string,
  automated: boolean,
): Promise<HostingerEmailSendingAccount> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("organization_email_connections")
      .select("mailbox_email,mailbox_password_encrypted,status,outbound_automation_enabled")
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (error) {
      if (["PGRST204", "PGRST205", "42703", "42P01"].includes(error.code)) {
        return { state: "unconfigured" };
      }
      logger.error("[email.hostinger] falha ao consultar caixa do canal", { code: error.code });
      return { state: "unavailable" };
    }
    if (!data) return { state: "unconfigured" };

    const row = data as {
      mailbox_email: string;
      mailbox_password_encrypted: string;
      status: string;
      outbound_automation_enabled: boolean;
    };
    if (row.status !== "healthy") return { state: "unavailable" };
    if (automated && !row.outbound_automation_enabled) return { state: "unconfigured" };

    const password = await decryptWebhookSecret(admin, row.mailbox_password_encrypted);
    if (!password) {
      logger.error("[email.hostinger] credencial do canal indisponível", { organizationId });
      return { state: "unavailable" };
    }
    return { state: "ready", credentials: { email: row.mailbox_email, password } };
  } catch {
    logger.error("[email.hostinger] falha ao carregar caixa do canal", { organizationId });
    return { state: "unavailable" };
  }
}

/**
 * Selects the tenant mailbox for automation delivery. Outbound sending requires
 * its own explicit opt-in; inbox polling is separate. An enabled but unhealthy
 * connection fails closed instead of silently sending as the platform.
 */
export async function getHostingerEmailAccountForSending(
  organizationId: string,
): Promise<HostingerEmailSendingAccount> {
  return getHostingerEmailAccountForChannel(organizationId, true);
}
