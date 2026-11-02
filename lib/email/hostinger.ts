import "server-only";

import { ImapFlow, type FetchMessageObject } from "imapflow";
import nodemailer from "nodemailer";
import PostalMime, { type Address } from "postal-mime";

const IMAP_HOST = "imap.hostinger.com";
const SMTP_HOST = "smtp.hostinger.com";
const IMAP_PORT = 993;
const SMTP_PORT = 465;
const CONNECT_TIMEOUT_MS = 8_000;
const SOCKET_TIMEOUT_MS = 15_000;
const MAX_MESSAGES_PER_PAGE = 25;
const MAX_RAW_MESSAGE_BYTES = 1_000_000;
const MAX_BODY_CHARACTERS = 20_000;

export interface HostingerEmailCredentials {
  email: string;
  password: string;
}

export interface HostingerEmailSendInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  fromName?: string;
  /** RFC 5322 identifiers used by the CRM inbox to keep replies in-thread. */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export type HostingerEmailSendResult =
  | { ok: true; id?: string }
  | { ok: false; error: "send_failed" | "rate_limited" | "sender_rejected"; details: string };

export type EmailConnectionState =
  | "connected"
  | "invalid_email"
  | "missing_credentials"
  | "authentication_failed"
  | "connection_failed"
  | "mailbox_unavailable";

export interface HostingerEmailAccessCheck {
  provider: "hostinger";
  outgoing: EmailConnectionState;
  incoming: EmailConnectionState;
  ready: boolean;
}

export interface HostingerInboxCursor {
  uidValidity: string;
  lastUid: number;
}

export interface HostingerInboxMessage {
  uid: number;
  untrusted: true;
  internalDate: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string | null;
  fromName: string | null;
  subject: string;
  text: string;
  contentState: "available" | "no_plain_text" | "too_large" | "parse_failed";
}

export type HostingerInboxPage =
  | {
      state: "ready";
      uidValidity: string;
      messages: HostingerInboxMessage[];
      proposedCursor: HostingerInboxCursor;
    }
  | {
      state: "uid_validity_changed";
      previousCursor: HostingerInboxCursor;
      observedUidValidity: string;
    }
  | {
      state: "invalid_credentials" | "connection_failed" | "authentication_failed" | "mailbox_unavailable";
    };

function validEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) &&
    !/[\r\n]/.test(value)
  );
}

function hasCredentials(credentials: HostingerEmailCredentials): boolean {
  return (
    typeof credentials.email === "string" &&
    typeof credentials.password === "string" &&
    credentials.password.length > 0 &&
    credentials.password.length <= 1_024
  );
}

function errorCode(error: unknown): { code?: string; responseCode?: number; message?: string } {
  if (!error || typeof error !== "object") return {};
  const value = error as { code?: unknown; responseCode?: unknown; message?: unknown };
  return {
    code: typeof value.code === "string" ? value.code.toUpperCase() : undefined,
    responseCode: typeof value.responseCode === "number" ? value.responseCode : undefined,
    message: typeof value.message === "string" ? value.message.toLowerCase() : undefined,
  };
}

function isAuthenticationFailure(error: unknown): boolean {
  const value = errorCode(error);
  return (
    value.responseCode === 535 ||
    value.code === "EAUTH" ||
    value.code === "AUTHENTICATIONFAILED" ||
    value.code === "AUTHENTICATION_FAILED" ||
    /auth(?:entication)? (?:failed|failure)|invalid credentials|login denied/.test(
      value.message ?? "",
    )
  );
}

function imapFailureState(error: unknown): "authentication_failed" | "connection_failed" {
  return isAuthenticationFailure(error) ? "authentication_failed" : "connection_failed";
}

function makeImapClient(credentials: HostingerEmailCredentials): ImapFlow {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: credentials.email.trim(), pass: credentials.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  // ImapFlow emits asynchronous socket errors as well as rejecting the active command.
  // Consume the event here; provider text can contain addresses or account details.
  client.on("error", () => undefined);
  return client;
}

async function closeImapClient(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

async function checkIncoming(credentials: HostingerEmailCredentials): Promise<EmailConnectionState> {
  const client = makeImapClient(credentials);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", {
      readOnly: true,
      acquireTimeout: CONNECT_TIMEOUT_MS,
      maxLockHoldTime: false,
    });
    lock.release();
    return "connected";
  } catch (error) {
    const code = errorCode(error).code;
    if (code?.includes("MAILBOX") || code?.includes("FOLDER")) return "mailbox_unavailable";
    return imapFailureState(error);
  } finally {
    await closeImapClient(client);
  }
}

async function checkOutgoing(credentials: HostingerEmailCredentials): Promise<EmailConnectionState> {
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: credentials.email.trim(), pass: credentials.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  try {
    await transport.verify();
    return "connected";
  } catch (error) {
    const value = errorCode(error);
    return value.responseCode === 535 || value.code === "EAUTH"
      ? "authentication_failed"
      : "connection_failed";
  } finally {
    transport.close();
  }
}

/** Checks IMAP and SMTP authentication without reading or sending any email. */
export async function checkHostingerEmailAccess(
  credentials: HostingerEmailCredentials,
): Promise<HostingerEmailAccessCheck> {
  if (!hasCredentials(credentials)) {
    return {
      provider: "hostinger",
      outgoing: "missing_credentials",
      incoming: "missing_credentials",
      ready: false,
    };
  }

  if (!validEmail(credentials.email.trim())) {
    return {
      provider: "hostinger",
      outgoing: "invalid_email",
      incoming: "invalid_email",
      ready: false,
    };
  }

  const [incoming, outgoing] = await Promise.all([
    checkIncoming(credentials),
    checkOutgoing(credentials),
  ]);
  return {
    provider: "hostinger",
    incoming,
    outgoing,
    ready: incoming === "connected" && outgoing === "connected",
  };
}

/** Sends from the verified organization mailbox; failures never fall back here. */
export async function sendHostingerEmail(
  credentials: HostingerEmailCredentials,
  input: HostingerEmailSendInput,
): Promise<HostingerEmailSendResult> {
  if (!hasCredentials(credentials) || !validEmail(credentials.email.trim())) {
    return { ok: false, error: "send_failed", details: "mailbox_credentials_unavailable" };
  }

  const messageId = input.messageId ? cleanHeader(input.messageId, 998) : undefined;
  const inReplyTo = input.inReplyTo ? cleanHeader(input.inReplyTo, 998) : undefined;
  const references = input.references?.map((value) => cleanHeader(value, 998));
  if (
    (messageId && !validMessageId(messageId)) ||
    (inReplyTo && !validMessageId(inReplyTo)) ||
    (references &&
      (references.length > 50 || references.some((value) => !validMessageId(value))))
  ) {
    return { ok: false, error: "send_failed", details: "invalid_thread_headers" };
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: credentials.email.trim(), pass: credentials.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  try {
    const fromName = cleanHeader(input.fromName, 128);
    const subject = cleanHeader(input.subject, 998);
    const replyTo = input.replyTo?.trim();
    const result = await transport.sendMail({
      from: fromName
        ? { name: fromName, address: credentials.email.trim() }
        : credentials.email.trim(),
      to: input.to,
      subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
      ...(replyTo && validEmail(replyTo) ? { replyTo } : {}),
      ...(messageId ? { messageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references?.length ? { references } : {}),
    });
    return { ok: true, ...(result.messageId ? { id: result.messageId } : {}) };
  } catch (error) {
    const value = errorCode(error);
    const responseCode = value.responseCode ?? 0;
    const code = value.code ?? "";
    const category =
      [421, 450, 451, 452, 429].includes(responseCode) || code === "ETIMEDOUT"
        ? "rate_limited"
        : [550, 553].includes(responseCode)
          ? "sender_rejected"
          : "send_failed";
    // Provider strings can contain mailbox addresses or server detail. Keep the
    // activity record useful without copying the raw SMTP response into CRM.
    const details = responseCode ? `smtp_response_${responseCode}` : code || "smtp_delivery_failed";
    return { ok: false, error: category, details };
  } finally {
    transport.close();
  }
}

/**
 * Establishes a starting point without importing an existing personal inbox.
 * Save this cursor before enabling synchronization for the mailbox.
 */
export async function createHostingerInboxCursor(
  credentials: HostingerEmailCredentials,
): Promise<HostingerInboxCursor | null> {
  if (!hasCredentials(credentials) || !validEmail(credentials.email.trim())) return null;

  const client = makeImapClient(credentials);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", {
      readOnly: true,
      acquireTimeout: CONNECT_TIMEOUT_MS,
      maxLockHoldTime: false,
    });
    try {
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.uidValidity === undefined || mailbox.uidNext === undefined) return null;
      return {
        uidValidity: mailbox.uidValidity.toString(),
        lastUid: Math.max(0, mailbox.uidNext - 1),
      };
    } finally {
      lock.release();
    }
  } catch {
    return null;
  } finally {
    await closeImapClient(client);
  }
}

function firstAddress(address: Address | undefined): string | null {
  if (!address) return null;
  if ("address" in address) return address.address || null;
  return address.group.find((member) => member.address)?.address ?? null;
}

function firstAddressName(address: Address | undefined): string | null {
  if (!address) return null;
  if ("address" in address) return cleanHeader(address.name, 200) || null;
  return cleanHeader(address.group.find((member) => member.address)?.name, 200) || null;
}

function cleanHeader(value: string | undefined, maxLength: number): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validMessageId(value: string): boolean {
  return value.length <= 998 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(value);
}

function cleanBody(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_BODY_CHARACTERS);
}

function referencesList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\s+/)
    .map((item) => cleanHeader(item, 998))
    .filter(Boolean)
    .slice(-50);
}

function parseFailureMessage(message: FetchMessageObject): HostingerInboxMessage {
  return {
    uid: message.uid,
    untrusted: true,
    internalDate:
      message.internalDate instanceof Date
        ? message.internalDate.toISOString()
        : typeof message.internalDate === "string"
          ? message.internalDate.slice(0, 64)
          : null,
    messageId: cleanHeader(message.envelope?.messageId, 998) || null,
    inReplyTo: cleanHeader(message.envelope?.inReplyTo, 998) || null,
    references: [],
    from: message.envelope?.from?.[0]?.address
      ? cleanHeader(message.envelope.from[0].address, 320)
      : null,
    fromName: cleanHeader(message.envelope?.from?.[0]?.name, 200) || null,
    subject: cleanHeader(message.envelope?.subject, 500),
    text: "",
    contentState: "too_large",
  };
}

async function parseInboxMessage(message: FetchMessageObject): Promise<HostingerInboxMessage> {
  const base = {
    uid: message.uid,
    untrusted: true as const,
    internalDate:
      message.internalDate instanceof Date
        ? message.internalDate.toISOString()
        : typeof message.internalDate === "string"
          ? message.internalDate.slice(0, 64)
          : null,
  };
  if (!message.source) {
    return {
      ...base,
      messageId: null,
      inReplyTo: null,
      references: [],
      from: null,
      fromName: null,
      subject: "",
      text: "",
      contentState: "parse_failed",
    };
  }

  try {
    const parsed = await PostalMime.parse(message.source, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 12,
      maxHeadersSize: 64_000,
      maxPartCount: 100,
      maxRfc822NestingDepth: 2,
    });
    const text = cleanBody(parsed.text);
    return {
      ...base,
      messageId: cleanHeader(parsed.messageId, 998) || null,
      inReplyTo: cleanHeader(parsed.inReplyTo, 998) || null,
      references: referencesList(parsed.references),
      from: cleanHeader(firstAddress(parsed.from) ?? undefined, 320) || null,
      fromName: firstAddressName(parsed.from),
      subject: cleanHeader(parsed.subject, 500),
      text,
      contentState: text ? "available" : "no_plain_text",
    };
  } catch {
    return {
      ...base,
      messageId: null,
      inReplyTo: null,
      references: [],
      from: null,
      fromName: null,
      subject: "",
      text: "",
      contentState: "parse_failed",
    };
  }
}

/**
 * Reads a bounded page from INBOX without changing message flags. The caller must
 * persist every returned item and its proposed cursor atomically before requesting
 * the next page. Email content is untrusted input; attachments and HTML are omitted.
 */
export async function readHostingerInboxPage(
  credentials: HostingerEmailCredentials,
  cursor: HostingerInboxCursor,
  options: { limit?: number } = {},
): Promise<HostingerInboxPage> {
  if (!hasCredentials(credentials) || !validEmail(credentials.email.trim())) {
    return { state: "invalid_credentials" };
  }
  if (!Number.isSafeInteger(cursor.lastUid) || cursor.lastUid < 0 || !/^\d+$/.test(cursor.uidValidity)) {
    return { state: "mailbox_unavailable" };
  }
  const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : 20;
  const limit = Math.max(1, Math.min(MAX_MESSAGES_PER_PAGE, requestedLimit));
  const client = makeImapClient(credentials);

  try {
    await client.connect();
  } catch (error) {
    const state = imapFailureState(error);
    await closeImapClient(client);
    return { state };
  }

  try {
    const lock = await client.getMailboxLock("INBOX", {
      readOnly: true,
      acquireTimeout: CONNECT_TIMEOUT_MS,
      maxLockHoldTime: false,
    });
    try {
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.uidValidity === undefined) return { state: "mailbox_unavailable" };
      const uidValidity = mailbox.uidValidity.toString();
      if (uidValidity !== cursor.uidValidity) {
        return { state: "uid_validity_changed", previousCursor: cursor, observedUidValidity: uidValidity };
      }

      const found = await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true });
      if (!Array.isArray(found)) return { state: "mailbox_unavailable" };
      const uids = found
        .filter((uid) => Number.isSafeInteger(uid) && uid > cursor.lastUid)
        .sort((left, right) => left - right)
        .slice(0, limit);

      if (uids.length === 0) {
        return {
          state: "ready",
          uidValidity,
          messages: [],
          proposedCursor: { uidValidity, lastUid: cursor.lastUid },
        };
      }

      const metadata = await client.fetchAll(
        uids,
        { uid: true, size: true, internalDate: true, envelope: true },
        { uid: true },
      );
      const eligible = metadata.filter(
        (message) => typeof message.size === "number" && message.size <= MAX_RAW_MESSAGE_BYTES,
      );
      const oversized = metadata.filter(
        (message) => typeof message.size !== "number" || message.size > MAX_RAW_MESSAGE_BYTES,
      );
      const rawMessages = eligible.length
        ? await client.fetchAll(
            eligible.map((message) => message.uid),
            { uid: true, source: { maxLength: MAX_RAW_MESSAGE_BYTES } },
            { uid: true },
          )
        : [];
      const parsed = await Promise.all(rawMessages.map(parseInboxMessage));
      const messages = [...parsed, ...oversized.map(parseFailureMessage)].sort(
        (left, right) => left.uid - right.uid,
      );

      return {
        state: "ready",
        uidValidity,
        messages,
        // A user can delete a message between SEARCH and FETCH. Advance through
        // the whole UID range observed by SEARCH, including such a gap, or the
        // worker would poll the same vanished UID forever.
        proposedCursor: { uidValidity, lastUid: uids.at(-1) ?? cursor.lastUid },
      };
    } finally {
      lock.release();
    }
  } catch (error) {
    const code = errorCode(error).code;
    return {
      state: code?.includes("MAILBOX") || code?.includes("FOLDER")
        ? "mailbox_unavailable"
        : imapFailureState(error),
    };
  } finally {
    await closeImapClient(client);
  }
}
