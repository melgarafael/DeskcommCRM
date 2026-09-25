import { isIP } from "node:net";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";
import { getSmtpConfig, type SmtpConfig } from "@/lib/email/config";

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  fromName?: string;
  tags?: { name: string; value: string }[];
}
export type EmailDeliveryError =
  "not_configured" | "send_failed" | "rate_limited" | "sender_rejected";
interface SendResult {
  ok: boolean;
  id?: string;
  error?: EmailDeliveryError;
  details?: string;
}
export type SmtpCheck =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "connection_failed" | "authentication_failed" };

let transporter: Transporter | null = null;
let transporterKey = "";

export function isSmtpConfigured(config: SmtpConfig): boolean {
  return Boolean(config.host && config.fromEmail);
}

export function formatFromAddress(config: SmtpConfig, override?: string): string | null {
  if (!config.fromEmail) return null;
  const name = (override ?? config.fromName).replace(/[<>"\r\n]/g, "").trim();
  return name ? `${name} <${config.fromEmail}>` : config.fromEmail;
}
/** A URL já é validada por lib/env; em desenvolvimento mantemos o padrão local. */
function smtpClientName(): string | undefined {
  const hostname = new URL(env.NEXT_PUBLIC_APP_URL).hostname;
  const address = hostname.replace(/^\[|\]$/g, "");
  if (isIP(address) === 4) return `[${address}]`;
  if (isIP(address) === 6) return `[IPv6:${address}]`;
  return hostname.includes(".") ? hostname : undefined;
}

function getTransport(config: SmtpConfig) {
  const name = smtpClientName();
  const key = `${name ?? ""}\0${config.host}\0${config.port}\0${config.security}\0${config.username}\0${config.password}`;
  if (transporter && transporterKey === key) return transporter;
  transporterKey = key;
  transporter = nodemailer.createTransport({
    // Docker usa hostname curto; o padrão do Nodemailer vira [127.0.0.1],
    // que alguns provedores aceitam e filtram depois. Identifique a instalação.
    name,
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
  });
  return transporter;
}
function classify(error: unknown): EmailDeliveryError {
  const value = error as { code?: string; responseCode?: number };
  if (value.responseCode === 429 || value.code === "ETIMEDOUT") return "rate_limited";
  if (value.responseCode === 550 || value.responseCode === 553) return "sender_rejected";
  return "send_failed";
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const config = await getSmtpConfig();
  const from = formatFromAddress(config, args.fromName);
  if (!isSmtpConfigured(config) || !from) return { ok: false, error: "not_configured" };
  try {
    const result = await getTransport(config).sendMail({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo,
    });
    return { ok: true, id: result.messageId };
  } catch (error) {
    return {
      ok: false,
      error: classify(error),
      details: error instanceof Error ? error.message : "SMTP send failed",
    };
  }
}

/** Testa conexão e autenticação SMTP sem enviar e-mail. */
export async function checkSmtpConfiguration(): Promise<SmtpCheck> {
  const config = await getSmtpConfig();
  if (!isSmtpConfigured(config)) return { ok: false, reason: "not_configured" };
  try {
    await getTransport(config).verify();
    return { ok: true };
  } catch (error) {
    const code = (error as { responseCode?: number }).responseCode;
    return { ok: false, reason: code === 535 ? "authentication_failed" : "connection_failed" };
  }
}
