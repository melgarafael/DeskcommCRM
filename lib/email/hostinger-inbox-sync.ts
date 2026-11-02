import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createHostingerInboxCursor,
  readHostingerInboxPage,
  type HostingerEmailCredentials,
  type HostingerInboxCursor,
  type HostingerInboxMessage,
} from "@/lib/email/hostinger";
import { getHostingerEmailCredentials } from "@/lib/email/hostinger-config";

type Admin = ReturnType<typeof createAdminClient>;

interface SyncConnection {
  id: string;
  organization_id: string;
  mailbox_email: string;
  inbox_uid_validity: string | null;
  inbox_last_uid: number;
}

interface SyncCounts {
  scanned: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  errors: number;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;
const PAGE_SIZE = 20;
const MAX_CONNECTIONS_PER_RUN = 20;
const CONNECTION_CLAIM_MS = 5 * 60 * 1000;

function normalizedEmail(value: string | null | undefined): string | null {
  const result = value?.trim().toLowerCase() ?? "";
  return result.length <= 254 && EMAIL_RE.test(result) && !/[\r\n]/.test(result) ? result : null;
}

function normalizedMessageId(value: string | null): string | null {
  if (!value) return null;
  const result = value.trim();
  return result.length <= 998 && MESSAGE_ID_RE.test(result) ? result.toLowerCase() : null;
}

function sentAt(value: string | null): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function externalId(connectionId: string, cursor: HostingerInboxCursor, uid: number): string {
  return `email-in:${connectionId}:${cursor.uidValidity}:${uid}`;
}

async function resolveContact(
  admin: Admin,
  organizationId: string,
  email: string,
  fromName: string | null,
): Promise<{ id: string; name: string | null; display_name: string | null } | null> {
  const query = () => admin
    .from("contacts")
    .select("id,name,display_name")
    .eq("organization_id", organizationId)
    .eq("email_normalized", email)
    .is("is_merged_into", null)
    .maybeSingle();

  const { data: existing, error: lookupError } = await query();
  if (lookupError) throw new Error(`contact_lookup_failed:${lookupError.code}`);
  if (existing) return existing as { id: string; name: string | null; display_name: string | null };

  const name = fromName?.trim().slice(0, 200) || null;
  const { data: created, error: insertError } = await admin
    .from("contacts")
    .insert({
      organization_id: organizationId,
      email,
      name,
      display_name: name,
      source: "email",
      source_metadata: { channel: "email", source: "hostinger_inbox" },
      consent: {},
    })
    .select("id,name,display_name")
    .single();
  if (!insertError && created) {
    return created as { id: string; name: string | null; display_name: string | null };
  }

  // Two cron invocations can observe a new address at once. The unique email
  // index is the arbiter; the loser rereads the winner rather than duplicating.
  if (insertError?.code === "23505") {
    const { data: raced, error: rereadError } = await query();
    if (!rereadError && raced) return raced as { id: string; name: string | null; display_name: string | null };
  }
  throw new Error(`contact_insert_failed:${insertError?.code ?? "empty"}`);
}

type EmailConversation = {
  id: string;
  metadata: Record<string, unknown>;
  provider_conversation_id: string | null;
};

interface ResolveEmailConversationInput {
  organizationId: string;
  contactId: string;
  sessionId: string;
  subject: string;
  threadRootId: string;
  threadCandidates: string[];
  providerConversationId: string | null;
}

async function findEmailConversation(
  admin: Admin,
  input: ResolveEmailConversationInput,
): Promise<EmailConversation | null> {
  const base = () => admin
    .from("conversations")
    .select("id,metadata,provider_conversation_id")
    .eq("organization_id", input.organizationId)
    .eq("contact_id", input.contactId)
    .eq("channel_session_id", input.sessionId)
    .eq("channel", "email")
    .eq("is_group", false);

  const { data: rooted, error: rootError } = await base()
    .filter("metadata->>email_thread_root_id", "eq", input.threadRootId)
    .maybeSingle();
  if (rootError) throw new Error(`email_thread_lookup_failed:${rootError.code}`);
  if (rooted) return rooted as EmailConversation;

  // Most replies match the newest RFC reference. The metadata array is scoped
  // to this contact and mailbox and also covers older replies with no
  // References header whose In-Reply-To points at a sent message.
  for (const candidate of input.threadCandidates) {
    const { data, error } = await base()
      .contains("metadata", { email_references: [candidate] })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`email_thread_reference_lookup_failed:${error.code}`);
    if (data) return data as EmailConversation;
  }

  // Older messages or concurrent outbound replies may have their latest
  // Message-ID in the canonical provider field even if it was not retained in
  // the JSON reference list. In-Reply-To is first in this ordered list, so
  // this indexed lookup normally costs one query and avoids merging threads.
  const latestCandidate = input.threadCandidates[0];
  if (latestCandidate) {
    const { data, error } = await base()
      .eq("provider_conversation_id", latestCandidate)
      .maybeSingle();
    if (error) throw new Error(`email_thread_provider_id_lookup_failed:${error.code}`);
    if (data) return data as EmailConversation;
  }
  return null;
}

async function resolveConversation(
  admin: Admin,
  input: ResolveEmailConversationInput,
): Promise<EmailConversation> {
  const existing = await findEmailConversation(admin, input);
  if (existing) return existing;

  const { data: created, error: insertError } = await admin
    .from("conversations")
    .insert({
      organization_id: input.organizationId,
      contact_id: input.contactId,
      channel_session_id: input.sessionId,
      channel: "email",
      // Keep a new conversation out of assignment until its first inbound
      // message reaches fn_service_inbound, which opens it with the message.
      status: "closed",
      is_group: false,
      provider_conversation_id: input.providerConversationId,
      metadata: {
        channel_kind: "email",
        email_subject: input.subject || "(sem assunto)",
        email_thread_root_id: input.threadRootId,
        email_references: [],
      },
    })
    .select("id,metadata,provider_conversation_id")
    .single();
  if (!insertError && created) return created as EmailConversation;

  // The thread-root index is the arbiter when two inbox cycles race.
  if (insertError?.code === "23505") {
    const raced = await findEmailConversation(admin, input);
    if (raced) return raced;
  }
  throw new Error(`conversation_insert_failed:${insertError?.code ?? "empty"}`);
}

async function upsertConversationEmailContext(
  admin: Admin,
  organizationId: string,
  conversation: EmailConversation,
  message: HostingerInboxMessage,
  threadRootId: string,
): Promise<void> {
  // RFC references accumulate only inside this already-resolved thread. The
  // root id remains stable while provider_conversation_id tracks the latest
  // actual Message-ID used for outbound replies.
  const previousReferences = Array.isArray(conversation.metadata.email_references)
    ? conversation.metadata.email_references
      .filter((id): id is string => typeof id === "string")
      .map((id) => normalizedMessageId(id))
      .filter((id): id is string => Boolean(id))
    : [];
  const references = [...new Set([
    ...previousReferences,
    ...message.references.map(normalizedMessageId).filter((id): id is string => Boolean(id)),
    normalizedMessageId(message.inReplyTo),
    normalizedMessageId(message.messageId),
  ].filter((id): id is string => Boolean(id)))].slice(-50);
  const metadata = {
    ...conversation.metadata,
    channel_kind: "email",
    email_subject: message.subject || "(sem assunto)",
    email_thread_root_id:
      typeof conversation.metadata.email_thread_root_id === "string"
        ? conversation.metadata.email_thread_root_id
        : threadRootId,
    email_references: references,
  };
  const { error } = await admin
    .from("conversations")
    .update({
      metadata,
      ...(normalizedMessageId(message.messageId)
        ? { provider_conversation_id: normalizedMessageId(message.messageId) }
        : {}),
    })
    .eq("organization_id", organizationId)
    .eq("id", conversation.id);
  if (error) throw new Error(`conversation_email_context_failed:${error.code}`);
}

interface StoredInboundMessage {
  id: string;
  conversation_id: string;
  contact_id: string;
  channel_session_id: string;
  body: string | null;
  sent_at: string;
  metadata: Record<string, unknown>;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const STORED_INBOUND_COLUMNS = "id,conversation_id,contact_id,channel_session_id,body,sent_at,metadata";

async function loadStoredInboundByRfc(
  admin: Admin,
  organizationId: string,
  sessionId: string,
  messageIdKey: string,
): Promise<StoredInboundMessage | null> {
  const { data, error } = await admin
    .from("messages")
    .select(STORED_INBOUND_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("channel_session_id", sessionId)
    .filter("metadata->>email_message_id_key", "eq", messageIdKey)
    .maybeSingle();
  if (error) throw new Error(`email_rfc_dedup_lookup_failed:${error.code}`);
  return data as unknown as StoredInboundMessage | null;
}

async function loadStoredInboundByExternalId(
  admin: Admin,
  organizationId: string,
  sessionId: string,
  id: string,
): Promise<StoredInboundMessage | null> {
  const { data, error } = await admin
    .from("messages")
    .select(STORED_INBOUND_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("channel_session_id", sessionId)
    .eq("external_id", id)
    .maybeSingle();
  if (error) throw new Error(`email_external_dedup_lookup_failed:${error.code}`);
  return data as unknown as StoredInboundMessage | null;
}

async function completePendingInboundEffects(
  admin: Admin,
  organizationId: string,
  message: StoredInboundMessage,
): Promise<void> {
  const metadata = metadataRecord(message.metadata);
  // Older rows predate the durable marker. Do not replay them: the original
  // turn may already have been handled manually or by the agent.
  if (metadata.email_inbound_effects_status !== "pending") return;

  const body = message.body ?? "";
  await marcarConversaComMensagem(admin, {
    organizationId,
    conversationId: message.conversation_id,
    direction: "inbound",
    preview: body.slice(0, 280),
    at: sentAt(message.sent_at),
    canal: "email",
    falharEmErro: true,
  });

  if (metadata.email_content_state === "available" && body.trim()) {
    const { data: contact, error: contactError } = await admin
      .from("contacts")
      .select("name,display_name")
      .eq("organization_id", organizationId)
      .eq("id", message.contact_id)
      .maybeSingle();
    if (contactError) throw new Error(`email_inbound_contact_lookup_failed:${contactError.code}`);
    if (!contact) throw new Error("email_inbound_contact_unavailable");

    await aplicarEfeitosPosEntrada(admin, {
      organizationId,
      contactId: message.contact_id,
      conversationId: message.conversation_id,
      messageId: message.id,
      channelSessionId: message.channel_session_id,
      texto: body,
      nomeDoContato: contact.display_name ?? contact.name,
      requestId: message.id,
      origem: "hostinger_imap",
      canal: "email",
      despachoIdempotente: true,
      despachoObrigatorio: true,
    });
  }

  // Merge against the latest row so unrelated metadata written after the
  // message insert is retained. The mailbox lease serializes this channel's
  // own retries; the event lookup above makes the agent dispatch replay-safe.
  const { data: current, error: currentError } = await admin
    .from("messages")
    .select("metadata")
    .eq("organization_id", organizationId)
    .eq("id", message.id)
    .maybeSingle();
  if (currentError || !current) {
    throw new Error(`email_inbound_effect_marker_lookup_failed:${currentError?.code ?? "empty"}`);
  }
  const { error: updateError } = await admin
    .from("messages")
    .update({
      metadata: {
        ...metadataRecord(current.metadata),
        email_inbound_effects_status: "completed",
      },
    })
    .eq("organization_id", organizationId)
    .eq("id", message.id);
  if (updateError) throw new Error(`email_inbound_effect_marker_update_failed:${updateError.code}`);
}

async function persistMessage(
  admin: Admin,
  input: {
    connection: SyncConnection;
    sessionId: string;
    cursor: HostingerInboxCursor;
    message: HostingerInboxMessage;
    credentials: HostingerEmailCredentials;
  },
): Promise<"inserted" | "duplicate" | "skipped"> {
  const from = normalizedEmail(input.message.from);
  if (!from || from === input.credentials.email.toLowerCase()) return "skipped";
  const messageIdKey = normalizedMessageId(input.message.messageId);
  if (messageIdKey) {
    const alreadyStored = await loadStoredInboundByRfc(
      admin,
      input.connection.organization_id,
      input.sessionId,
      messageIdKey,
    );
    if (alreadyStored) {
      await completePendingInboundEffects(admin, input.connection.organization_id, alreadyStored);
      return "duplicate";
    }
  }
  const contact = await resolveContact(admin, input.connection.organization_id, from, input.message.fromName);
  if (!contact) throw new Error("contact_unavailable");
  const normalizedReferences = input.message.references
    .map(normalizedMessageId)
    .filter((id): id is string => Boolean(id));
  const inReplyTo = normalizedMessageId(input.message.inReplyTo);
  const threadCandidates = [...new Set([
    ...(inReplyTo ? [inReplyTo] : []),
    ...normalizedReferences.slice().reverse(),
  ])];
  const threadRootId = normalizedReferences[0]
    ?? inReplyTo
    ?? messageIdKey
    ?? `legacy:${contact.id}`;
  const conversation = await resolveConversation(admin, {
    organizationId: input.connection.organization_id,
    contactId: contact.id,
    sessionId: input.sessionId,
    subject: input.message.subject,
    threadRootId,
    threadCandidates,
    providerConversationId: messageIdKey,
  });
  await upsertConversationEmailContext(
    admin,
    input.connection.organization_id,
    conversation,
    input.message,
    threadRootId,
  );
  const at = sentAt(input.message.internalDate);
  const messageExternalId = externalId(input.connection.id, input.cursor, input.message.uid);
  const body = input.message.contentState === "available"
    ? input.message.text
    : input.message.contentState === "no_plain_text"
      ? "Esta mensagem não contém texto simples. Anexos e conteúdo HTML não foram importados."
      : "Não foi possível ler o conteúdo desta mensagem. Consulte a caixa original.";

  const { data, error } = await admin
    .from("messages")
    .insert({
      organization_id: input.connection.organization_id,
      conversation_id: conversation.id,
      channel_session_id: input.sessionId,
      contact_id: contact.id,
      external_id: messageExternalId,
      type: "text",
      direction: "inbound",
      status: "delivered",
      sent_via: "external_device",
      sent_at: at,
      body,
      metadata: {
        email_subject: input.message.subject,
        email_from: from,
        email_from_name: input.message.fromName,
        email_message_id: input.message.messageId,
        email_message_id_key: messageIdKey,
        email_in_reply_to: input.message.inReplyTo && MESSAGE_ID_RE.test(input.message.inReplyTo)
          ? input.message.inReplyTo
          : null,
        email_references: input.message.references.filter((id) => MESSAGE_ID_RE.test(id)),
        email_uid: input.message.uid,
        email_uid_validity: input.cursor.uidValidity,
        email_content_state: input.message.contentState,
        email_inbound_effects_status: "pending",
        external_content_untrusted: true,
      },
    })
    .select(STORED_INBOUND_COLUMNS)
    .maybeSingle();

  if (error?.code === "23505") {
    const alreadyStored = (messageIdKey
      ? await loadStoredInboundByRfc(admin, input.connection.organization_id, input.sessionId, messageIdKey)
      : null) ?? await loadStoredInboundByExternalId(
      admin,
      input.connection.organization_id,
      input.sessionId,
      messageExternalId,
    );
    if (!alreadyStored) throw new Error("email_duplicate_message_unavailable");
    await completePendingInboundEffects(admin, input.connection.organization_id, alreadyStored);
    return "duplicate";
  }
  if (error || !data) throw new Error(`message_insert_failed:${error?.code ?? "empty"}`);

  // The history contains only the plain text body. RFC identifiers stay in
  // metadata and the visible preview never contains provider headers. The
  // pending marker commits with the message so a crash resumes on next sync.
  await completePendingInboundEffects(
    admin,
    input.connection.organization_id,
    data as unknown as StoredInboundMessage,
  );
  return "inserted";
}

async function resolveChannelSession(admin: Admin, organizationId: string, connectionId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "hostinger_email")
    .eq("metadata->>email_connection_id", connectionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`channel_session_lookup_failed:${error.code}`);
  return (data as { id: string } | null)?.id ?? null;
}

async function claimConnection(admin: Admin, connection: SyncConnection, token: string): Promise<boolean> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + CONNECTION_CLAIM_MS).toISOString();
  const { data, error } = await admin
    .from("organization_email_connections")
    .update({ inbox_claim_token: token, inbox_claim_until: leaseUntil })
    .eq("organization_id", connection.organization_id)
    .eq("id", connection.id)
    .eq("status", "healthy")
    .eq("inbox_sync_enabled", true)
    .or(`inbox_claim_until.is.null,inbox_claim_until.lt.${now.toISOString()}`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`email_sync_claim_failed:${error.code}`);
  return Boolean(data);
}

async function renewConnectionClaim(
  admin: Admin,
  connection: SyncConnection,
  token: string,
): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + CONNECTION_CLAIM_MS).toISOString();
  const { data, error } = await admin
    .from("organization_email_connections")
    .update({ inbox_claim_until: leaseUntil })
    .eq("organization_id", connection.organization_id)
    .eq("id", connection.id)
    .eq("inbox_claim_token", token)
    .eq("status", "healthy")
    .eq("inbox_sync_enabled", true)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`email_sync_claim_renew_failed:${error.code}`);
  return Boolean(data);
}

async function releaseConnectionClaim(admin: Admin, connection: SyncConnection, token: string): Promise<void> {
  const { error } = await admin
    .from("organization_email_connections")
    .update({ inbox_claim_token: null, inbox_claim_until: null })
    .eq("organization_id", connection.organization_id)
    .eq("id", connection.id)
    .eq("inbox_claim_token", token);
  if (error) {
    logger.warn("[email.hostinger] lease da caixa não foi liberado; expira automaticamente", {
      organization_id: connection.organization_id,
      connection_id: connection.id,
      code: error.code,
    });
  }
}

async function markConnectionError(
  admin: Admin,
  connection: SyncConnection,
  token: string,
  code: string,
): Promise<void> {
  await admin
    .from("organization_email_connections")
    .update({ last_error_code: code, last_sync_at: new Date().toISOString() })
    .eq("organization_id", connection.organization_id)
    .eq("id", connection.id)
    .eq("inbox_claim_token", token);
}

export async function syncHostingerInboxes(admin: Admin = createAdminClient()): Promise<SyncCounts> {
  const counts: SyncCounts = { scanned: 0, inserted: 0, duplicates: 0, skipped: 0, errors: 0 };
  const eligibleBefore = new Date().toISOString();
  const { data, error } = await admin
    .from("organization_email_connections")
    .select("id,organization_id,mailbox_email,inbox_uid_validity,inbox_last_uid")
    .eq("status", "healthy")
    .eq("inbox_sync_enabled", true)
    .not("inbox_uid_validity", "is", null)
    .or(`inbox_claim_until.is.null,inbox_claim_until.lt.${eligibleBefore}`)
    .order("last_sync_at", { ascending: true, nullsFirst: true })
    .limit(MAX_CONNECTIONS_PER_RUN);
  if (error) throw new Error(`email_sync_connections_failed:${error.code}`);

  for (const raw of data ?? []) {
    const candidate = raw as SyncConnection;
    const claimToken = randomUUID();
    let claimed: boolean;
    try {
      claimed = await claimConnection(admin, candidate, claimToken);
    } catch (claimError) {
      counts.errors++;
      logger.warn("[email.hostinger] não foi possível reservar a caixa", {
        organization_id: candidate.organization_id,
        connection_id: candidate.id,
        code: claimError instanceof Error ? claimError.message.split(":")[0] : "unknown",
      });
      continue;
    }
    if (!claimed) continue;
    const { data: current, error: currentError } = await admin
      .from("organization_email_connections")
      .select("id,organization_id,mailbox_email,inbox_uid_validity,inbox_last_uid")
      .eq("organization_id", candidate.organization_id)
      .eq("id", candidate.id)
      .eq("inbox_claim_token", claimToken)
      .eq("status", "healthy")
      .eq("inbox_sync_enabled", true)
      .maybeSingle();
    if (currentError || !current) {
      counts.errors += currentError ? 1 : 0;
      await releaseConnectionClaim(admin, candidate, claimToken);
      if (currentError) {
        logger.warn("[email.hostinger] configuração da caixa mudou após a reserva", {
          organization_id: candidate.organization_id,
          connection_id: candidate.id,
          code: currentError.code,
        });
      }
      continue;
    }
    const connection = current as SyncConnection;
    counts.scanned++;
    try {
    const credentials = await getHostingerEmailCredentials(connection.organization_id);
    if (!credentials) {
      counts.errors++;
      await markConnectionError(admin, connection, claimToken, "email_credential_unavailable");
      continue;
    }
    const sessionId = await resolveChannelSession(admin, connection.organization_id, connection.id);
    if (!sessionId) {
      counts.errors++;
      await markConnectionError(admin, connection, claimToken, "email_channel_session_unavailable");
      continue;
    }
    const cursor: HostingerInboxCursor = {
      uidValidity: connection.inbox_uid_validity as string,
      lastUid: Number(connection.inbox_last_uid),
    };
    const page = await readHostingerInboxPage(credentials, cursor, { limit: PAGE_SIZE });
    if (page.state === "uid_validity_changed") {
      // A mailbox reset invalidates old UIDs. Start from the newest UID so that
      // a reset never imports a historical personal inbox or replies to old mail.
      const latest = await createHostingerInboxCursor(credentials);
      if (!latest) {
        counts.errors++;
        await markConnectionError(admin, connection, claimToken, "email_mailbox_cursor_unavailable");
        continue;
      }
      const { data: reset, error: resetError } = await admin
        .from("organization_email_connections")
        .update({
          inbox_uid_validity: latest.uidValidity,
          inbox_last_uid: latest.lastUid,
          last_error_code: "email_uid_validity_reset_skipped_history",
          last_sync_at: new Date().toISOString(),
        })
        .eq("id", connection.id)
        .eq("organization_id", connection.organization_id)
        .eq("inbox_claim_token", claimToken)
        .eq("status", "healthy")
        .eq("inbox_uid_validity", cursor.uidValidity)
        .eq("inbox_last_uid", cursor.lastUid)
        .select("id")
        .maybeSingle();
      if (resetError || !reset) counts.errors++;
      else counts.skipped++;
      continue;
    }
    if (page.state !== "ready") {
      counts.errors++;
      await markConnectionError(admin, connection, claimToken, `email_imap_${page.state}`);
      continue;
    }

    let failed = false;
    for (const message of page.messages) {
      try {
        if (!(await renewConnectionClaim(admin, connection, claimToken))) {
          failed = true;
          counts.errors++;
          logger.warn("[email.hostinger] reserva da caixa expirou; cursor mantido", {
            organization_id: connection.organization_id,
            connection_id: connection.id,
          });
          break;
        }
        const outcome = await persistMessage(admin, {
          connection,
          sessionId,
          cursor: { uidValidity: page.uidValidity, lastUid: message.uid },
          message,
          credentials,
        });
        counts[outcome === "inserted" ? "inserted" : outcome === "duplicate" ? "duplicates" : "skipped"]++;
      } catch (error) {
        failed = true;
        counts.errors++;
        logger.warn("[email.hostinger] mensagem de entrada não persistida; cursor mantido", {
          organization_id: connection.organization_id,
          connection_id: connection.id,
          uid: message.uid,
          code: error instanceof Error ? error.message.split(":")[0] : "unknown",
        });
        await markConnectionError(admin, connection, claimToken, "email_inbound_persist_failed");
        break;
      }
    }
    if (failed) continue;
    if (!(await renewConnectionClaim(admin, connection, claimToken))) {
      counts.errors++;
      logger.warn("[email.hostinger] reserva da caixa expirou antes do cursor; avanço cancelado", {
        organization_id: connection.organization_id,
        connection_id: connection.id,
      });
      continue;
    }

    // The lease serializes the full page. Compare-and-set remains a second guard
    // against stale workers after an administrator toggles the sync setting.
    const { data: advanced, error: cursorError } = await admin
      .from("organization_email_connections")
      .update({
        inbox_uid_validity: page.proposedCursor.uidValidity,
        inbox_last_uid: page.proposedCursor.lastUid,
        last_sync_at: new Date().toISOString(),
        last_error_code: null,
      })
      .eq("id", connection.id)
      .eq("organization_id", connection.organization_id)
      .eq("inbox_claim_token", claimToken)
      .eq("status", "healthy")
      .eq("inbox_uid_validity", cursor.uidValidity)
      .eq("inbox_last_uid", cursor.lastUid)
      .eq("inbox_sync_enabled", true)
      .select("id")
      .maybeSingle();
    if (cursorError || !advanced) {
      counts.errors++;
      logger.info("[email.hostinger] cursor já avançado por outra rodada", {
        organization_id: connection.organization_id,
        connection_id: connection.id,
      });
    }
    } finally {
      await releaseConnectionClaim(admin, connection, claimToken);
    }
  }
  return counts;
}

export type HostingerInboxSyncAdminClient = SupabaseClient;
