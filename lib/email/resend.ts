/**
 * Transactional email wrapper (Brevo or Resend). The module path stays compatible.
 * Usado por: convites de team, LGPD (export + alarme de SLA).
 *
 * ── O remetente é do OPERADOR; o nome de exibição é da MARCA ─────────────────
 *
 * `RESEND_FROM_EMAIL` é um endereço de um domínio que precisa estar VERIFICADO
 * na conta Resend de quem instalou — é do operador, e nenhuma resolução de
 * marca muda isso. O que a marca resolve é o NOME de exibição (`fromName`),
 * que é o que o destinatário lê na caixa de entrada. É aqui que o white-label
 * do remetente acontece, e é só aqui.
 *
 * ── Por que vazio significa NÃO CONFIGURADO ─────────────────────────────────
 *
 * O fallback antigo era `"Deskcomm <noreply@deskcomm.app>"`. Num clone isso é
 * PIOR que nada: o domínio não está verificado na conta Resend do revendedor,
 * então TODO envio falha lá na Resend e volta como `send_failed` com mensagem
 * opaca — o operador vai caçar rede, contêiner e chave, quando o problema é uma
 * variável em branco. Tratar como não-configurado joga o fluxo no caminho que
 * JÁ existe e JÁ é bom: `EmailNotConfigured` → `pending_review` no worker de
 * LGPD (`workers/lgpd-export-worker.ts:254-289`) e o convite mostrando o
 * `accept_url` na tela (`app/api/v1/team/invite/route.ts`).
 *
 * As duas chaves saíram do `process.env` cru e entraram no Zod (`lib/env.ts`).
 * Fora dele elas ficavam fora do `.env.example` e fora do `install.sh`, e o
 * `.env` é escrito com truncamento: chave posta à mão sumia no update seguinte.
 */
import { Resend } from "resend";

import { env } from "@/lib/env";

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
  /**
   * Nome de exibição do remetente — a marca resolvida (`marcaDaSaida().nome`).
   * Ausente usa o endereço puro: quem não passa marca não ganha a nossa.
   */
  fromName?: string;
}

interface SendResult {
  ok: boolean;
  id?: string;
  error?: "not_configured" | "send_failed" | "rate_limited" | "dominio_nao_verificado";
  details?: string;
}

let _client: Resend | null = null;

function getClient(): Resend | null {
  if (_client) return _client;
  const key = env.RESEND_API_KEY;
  if (!key || key.length < 10) return null;
  _client = new Resend(key);
  return _client;
}

/**
 * `null` = não há remetente utilizável. Nunca inventa um domínio nosso.
 *
 * O nome de exibição é sanitizado: `<`, `>`, `"` e quebra de linha dentro do
 * cabeçalho `From:` são injeção de cabeçalho SMTP, e a marca vem de um campo
 * que o operador digita numa tela.
 */
export function fromAddress(fromName?: string): string | null {
  const endereco = (env.BREVO_API_KEY?.trim()
    ? env.BREVO_FROM_EMAIL ?? ""
    : env.RESEND_FROM_EMAIL).trim();
  if (endereco.length === 0) return null;
  const nome = (fromName ?? "").replace(/[<>"\r\n]/g, "").trim();
  return nome.length > 0 ? `${nome} <${endereco}>` : endereco;
}

/**
 * A Resend recusa domínio não verificado com uma mensagem própria, e o ramo
 * genérico `send_failed` a apagava. Classificar aqui é o que faz a diferença
 * entre "reinicie o container" e "verifique seu domínio na Resend" — a lição
 * já paga neste projeto: erro que não nomeia a causa vira caça ao fantasma.
 */
function classificar(nome: string, mensagem: string): NonNullable<SendResult["error"]> {
  if (nome.toLowerCase().includes("rate")) return "rate_limited";
  if (/not verified|domain is not verified|não verificad/i.test(mensagem)) {
    return "dominio_nao_verificado";
  }
  return "send_failed";
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  if (env.BREVO_API_KEY?.trim()) return sendWithBrevo(args);
  const client = getClient();
  const from = fromAddress(args.fromName);

  if (!client || !from) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[email] envio desligado — falta RESEND_API_KEY ou RESEND_FROM_EMAIL. Payload:",
        {
          to: args.to,
          subject: args.subject,
          preview: args.text?.slice(0, 200) ?? args.html.slice(0, 200),
          tem_chave: client !== null,
          tem_remetente: from !== null,
        },
      );
    }
    return { ok: false, error: "not_configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo,
      tags: args.tags,
    });

    if (error) {
      return {
        ok: false,
        error: classificar(String(error.name || ""), error.message ?? ""),
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

/**
 * Chave E remetente. Só a chave não basta: com `RESEND_FROM_EMAIL` vazio todo
 * envio devolve `not_configured`, e uma tela que dissesse "e-mail configurado"
 * mandaria o operador esperar uma mensagem que nunca sai.
 */
export function isEmailConfigured(): boolean {
  if (env.BREVO_API_KEY?.trim()) return fromAddress() !== null;
  return getClient() !== null && fromAddress() !== null;
}

async function sendWithBrevo(args: SendArgs): Promise<SendResult> {
  const email = env.BREVO_FROM_EMAIL?.trim();
  if (!email) return { ok: false, error: "not_configured" };
  const name = args.fromName?.replace(/[<>"\r\n]/g, "").trim();
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY.trim(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email, ...(name ? { name } : {}) },
        to: (Array.isArray(args.to) ? args.to : [args.to]).map((to) => ({ email: to })),
        subject: args.subject,
        htmlContent: args.html,
        ...(args.text ? { textContent: args.text } : {}),
        ...(args.replyTo ? { replyTo: { email: args.replyTo } } : {}),
        ...(args.tags?.length ? { tags: args.tags.map(({ name, value }) => `${name}:${value}`) } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) {
      return {
        ok: false,
        error: response.status === 429 ? "rate_limited" : "send_failed",
        details: `Brevo HTTP ${response.status}`,
      };
    }
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("messageId" in result)
      || typeof result.messageId !== "string" || !result.messageId.trim()) {
      return { ok: false, error: "send_failed", details: "Brevo response missing messageId" };
    }
    return { ok: true, id: result.messageId };
  } catch {
    // No automatic retry/fallback: an interrupted response may already have been accepted.
    return { ok: false, error: "send_failed", details: "Brevo request failed" };
  }
}
