import { sendHostingerEmail } from "@/lib/email/hostinger";
import { checkHostingerEmailAccess } from "@/lib/email/hostinger";
import { getHostingerEmailAccountForChannel, getHostingerEmailAccountForHealth } from "@/lib/email/hostinger-config";
import type { ChannelAdapter, OutboundEnvelope, RecipientInput } from "../types";

function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return null;
  return email;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br>");
}

function replySubject(value: string | null | undefined): string {
  const subject = (value ?? "").replace(/[\r\n\u0000-\u001f]/g, " ").trim().slice(0, 480);
  if (!subject) return "Mensagem";
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function validMessageId(value: string | null | undefined): value is string {
  return !!value && value.length <= 998 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(value);
}

export const hostingerEmailAdapter: ChannelAdapter = {
  provider: "hostinger_email",

  resolveRecipient(input: RecipientInput): string | null {
    return normalizeEmail(input.email);
  },

  // The connection row/session is only created after SMTP and IMAP are verified.
  // Account health and the automation opt-in are checked again at send time.
  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: "email_nao_configurado",
    sendFailed: "email_recusado",
    unknownError: "email_falhou",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.kind !== "text") throw new Error("email_unsupported_message_type");
    const body = envelope.body?.trim() ?? "";
    if (!body) throw new Error("email_empty_body");

    const account = await getHostingerEmailAccountForChannel(
      envelope.organizationId,
      envelope.automated === true,
    );
    if (account.state !== "ready") throw new Error(account.state === "unconfigured" ? "email_nao_configurado" : "email_connection_unavailable");

    const replyTo = validMessageId(envelope.replyToExternalId)
      ? envelope.replyToExternalId
      : validMessageId(envelope.providerConversationId)
        ? envelope.providerConversationId
        : null;
    const references = [...new Set([
      ...(envelope.emailReferences ?? []).filter(validMessageId),
      ...(replyTo ? [replyTo] : []),
    ])].slice(-50);
    const result = await sendHostingerEmail(account.credentials, {
      to: envelope.to,
      subject: replySubject(envelope.emailSubject),
      text: body,
      html: `<div>${escapeHtml(body)}</div>`,
      ...(replyTo ? { inReplyTo: replyTo } : {}),
      ...(references.length ? { references } : {}),
    });
    if (!result.ok) throw new Error(result.details || result.error);
    return { externalId: result.id ?? null };
  },

  async checkHealth({ organizationId }) {
    const account = await getHostingerEmailAccountForHealth(organizationId);
    if (account.state === "unconfigured") {
      return { reachable: true, status: "STOPPED", detail: "email_connection_not_configured" };
    }
    if (account.state !== "ready") {
      return { reachable: true, status: "FAILED", detail: "email_credential_unavailable" };
    }
    const access = await checkHostingerEmailAccess(account.credentials);
    if (access.ready) return { reachable: true, status: "WORKING", detail: null };
    const states = [access.incoming, access.outgoing];
    if (states.includes("connection_failed")) {
      return { reachable: false, status: null, detail: "email_provider_unreachable" };
    }
    return { reachable: true, status: "FAILED", detail: "email_authentication_failed" };
  },
};
