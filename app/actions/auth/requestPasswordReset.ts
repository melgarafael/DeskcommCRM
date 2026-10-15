"use server";

import { headers } from "next/headers";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { lerSmtp } from "@/lib/email/config";
import { isSmtpConfigured } from "@/lib/email/smtp";

export type RequestPasswordResetResult =
  | { ok: true }
  | {
      ok: false;
      error: "validation_error" | "rate_limited" | "smtp_not_configured" | "request_failed";
      details?: Record<string, unknown>;
    };

/**
 * Single-server sem SMTP no CRM: o GoTrue desta VPS não tem por onde mandar
 * e-mail, porque é o kit (`sincronizar_smtp_do_gotrue`, em `_common.sh`) que
 * leva o SMTP do CRM até ele. Mesma régua do kit: host E remetente.
 *
 * Só afirma "sem SMTP" quando o banco RESPONDEU — um soluço dele não é falta de
 * configuração, e aí segue o caminho de sempre.
 *
 * Fora do single-server o login tem e-mail próprio (Supabase na nuvem ou
 * separado), e "configure em /admin/email" não resolveria: nada muda lá.
 *
 * Limite aceito: o operador single-server que pôs SMTP direto no `.env` do
 * Supabase, sem passar pela tela, ouve "sem SMTP" com um e-mail que sairia. O
 * app não enxerga aquele arquivo, e o remédio é o caminho documentado:
 * configurar o mesmo SMTP em /admin/email (que o kit passa a sincronizar).
 */
async function semSmtpNoSingleServer(): Promise<boolean> {
  if (process.env.SINGLE_SERVER !== "1") return false;
  const { config, bancoRespondeu } = await lerSmtp();
  return bancoRespondeu && !isSmtpConfigured(config);
}

/**
 * Pede o e-mail de redefinição de senha. Resposta neutra quanto à existência
 * do e-mail (o GoTrue responde 200 para e-mail desconhecido — não vaza nada);
 * erros aqui são só de infra (SMTP, rate limit).
 */
export async function requestPasswordReset(
  input: ForgotPasswordInput,
): Promise<RequestPasswordResetResult> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const hdrs = await headers();
  const origin = hdrs.get("origin") ?? env.NEXT_PUBLIC_APP_URL;
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // Sem teto, este endpoint é uma metralhadora de e-mail contra terceiros e um
  // oráculo de enumeração de conta. Issue #64.
  if (await authRateLimited("reset", parsed.data.email, AUTH_LIMITS.reset)) {
    return { ok: false, error: "rate_limited" };
  }

  // #2755 — decidido ANTES de chamar o GoTrue, sem olhar o que ele responde:
  // assim a resposta depende só da instalação, nunca do e-mail digitado.
  if (await semSmtpNoSingleServer()) return { ok: false, error: "smtp_not_configured" };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    // ?type=recovery sobrevive ao redirect do GoTrue (preserva query string
    // existente ao anexar `code=`/`token_hash=`) — sem SMTP customizado o
    // Supabase usa o template padrão dele, que só devolve `code` (PKCE), sem
    // `type`; /auth/confirm depende deste param pra saber que é recovery.
    redirectTo: `${origin}/auth/confirm?type=recovery`,
  });

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };
    await audit({
      action: "auth.password_reset_request_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error.message,
      },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "request_failed" };
  }

  await audit({
    action: "auth.password_reset_requested",
    metadata: { email_hash: hashEmail(parsed.data.email) },
    requestId,
    ip,
    userAgent,
  });

  return { ok: true };
}
