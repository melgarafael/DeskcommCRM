"use server";

import { headers } from "next/headers";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { semSmtpNaInstalacao } from "@/lib/email/estado";

export type RequestPasswordResetResult =
  | { ok: true }
  | {
      ok: false;
      error: "validation_error" | "rate_limited" | "smtp_not_configured" | "request_failed";
      details?: Record<string, unknown>;
    };

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

  // #3039 — a régua da instalação fala do CRM, e continua valendo: sem SMTP
  // aqui (host E remetente), o GoTrue deste servidor pode não ter por onde
  // mandar. Mas ela NÃO decide sozinha: quem põe o SMTP direto no `.env` do
  // Supabase — o arquivo que só o GoTrue lê — faz o e-mail SAIR por um caminho
  // que o app não enxerga (é o limite que `lib/email/estado.ts` declara). A
  // resposta pronta aqui recusava uma recuperação que funcionaria: medido em
  // #3039, com o aviso na tela e nada enviado ao GoTrue. Então a pergunta ao
  // GoTrue acontece, e quem decide é a resposta DELE: `smtp_not_configured` só
  // quando ele diz que não conseguiu enviar — a mesma medida do cadastro
  // (`/error sending/i` em `app/actions/auth/signUp.ts`).
  const semSmtpNoCrm = await semSmtpNaInstalacao();

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
    // O GoTrue recusou por não conseguir enviar: aí sim "sem SMTP" é verdade —
    // e a frase da tela diz o que aconteceu, sem afirmar nada sobre instalação
    // que tem SMTP por outro caminho.
    if (semSmtpNoCrm && /error sending/i.test(error.message))
      return { ok: false, error: "smtp_not_configured" };
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
