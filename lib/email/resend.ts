/**
 * Resend wrapper. Usado por: convites de team, magic links, notificações operacionais.
 *
 * Comportamento defensivo: quando RESEND_API_KEY não está configurada, faz log
 * do payload no console em DEV (nunca em prod) e retorna { ok: false, error: 'not_configured' }
 * — o caller decide se isso é fatal ou não. Convites NÃO devem falhar silenciosamente
 * em prod; em dev, o log permite que o flow continue sem credenciais reais.
 */
import { Resend } from "resend";

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
}

interface SendResult {
  ok: boolean;
  id?: string;
  error?: "not_configured" | "send_failed" | "rate_limited";
  details?: string;
}

let _client: Resend | null = null;

function getClient(): Resend | null {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key || key.length < 10) return null;
  _client = new Resend(key);
  return _client;
}

function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL || "Deskcomm <noreply@deskcomm.app>";
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const client = getClient();

  if (!client) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[email] RESEND_API_KEY não configurada — email não enviado. Payload:",
        {
          to: args.to,
          subject: args.subject,
          preview: args.text?.slice(0, 200) ?? args.html.slice(0, 200),
        },
      );
      return { ok: false, error: "not_configured" };
    }
    return { ok: false, error: "not_configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from: fromAddress(),
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo,
      tags: args.tags,
    });

    if (error) {
      const isRateLimit = String(error.name || "").toLowerCase().includes("rate");
      return {
        ok: false,
        error: isRateLimit ? "rate_limited" : "send_failed",
        details: error.message,
      };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    return {
      ok: false,
      error: "send_failed",
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isEmailConfigured(): boolean {
  return getClient() !== null;
}
