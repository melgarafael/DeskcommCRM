"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { safeNext } from "@/lib/auth/safe-next";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { audit, hashEmail } from "@/lib/audit";
import { reconhecerDispositivoConfiavel } from "@/lib/auth/dispositivo-confiavel";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import {
  authRateLimited,
  bloqueioProgressivoDeConta,
  contaBloqueadaPorFalhas,
  registrarFalhaDeLogin,
  falhasNaJanelaDiaria,
  AUTH_LIMITS,
} from "@/lib/auth/rate-limit";

export type SignInResult = {
  ok: false;
  error: "invalid_credentials" | "rate_limited" | "validation_error" | "mfa_required";
  details?: Record<string, unknown>;
  challengeId?: string;
};

/**
 * Sign in with password.
 *
 * On success: redirects server-side to `next` (or /app/inbox / /onboarding/mfa).
 * The redirect ensures Set-Cookie headers from supabase.auth propagate before
 * middleware re-evaluates the session — fixes Next 15 Server Action cookie
 * propagation race.
 *
 * On failure: returns an error discriminator. Caller renders inline message.
 */
export async function signInWithPassword(input: LoginInput, next?: string): Promise<SignInResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // Antes de falar com o GoTrue: sem isto, tentar senha era de graça e
  // ilimitado (issue #64). Conta por IP e por conta — o ataque distribuído
  // contra um e-mail só não aparece na contagem por IP.
  //
  // O bloqueio progressivo (issue #4743) é a janela do dia (vira à meia-noite
  // UTC): a de 5 min zera, e 5 erros a cada 5 min davam ~1.440 tentativas por
  // dia contra a mesma conta.
  // O balde é derivado do e-mail APRESENTADO, exista a conta ou não, então a
  // resposta é a mesma sequência para e-mail inexistente — o bloqueio não pode
  // virar oráculo de enumeração.
  const bloqueio = await bloqueioProgressivoDeConta(parsed.data.email);
  if (
    (await authRateLimited("login", null, AUTH_LIMITS.login)) ||
    (await contaBloqueadaPorFalhas(parsed.data.email, AUTH_LIMITS.login)) ||
    bloqueio.bloqueado
  ) {
    await audit({
      // A tentativa barrada é SEMPRE `auth.login_rate_limited`, como antes da
      // régua: o evento do degrau (`auth.login_bloqueio_*`) é gravado uma vez,
      // quando o castigo nasce (abaixo). Gravá-lo de novo a cada tentativa
      // barrada faria a auditoria parecer ter tido vários bloqueios. O degrau
      // vai anotado ao lado.
      action: "auth.login_rate_limited",
      metadata: bloqueio.bloqueado
        ? {
            email_hash: hashEmail(parsed.data.email),
            degrau: bloqueio.degrau,
            restante_seg: bloqueio.restanteSec,
          }
        : { email_hash: hashEmail(parsed.data.email) },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "rate_limited" };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.user) {
    // Só senha errada gasta o orçamento da conta.
    const degrau = await registrarFalhaDeLogin(parsed.data.email, AUTH_LIMITS.login);
    await audit({
      action: "auth.login_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error?.message ?? "unknown",
      },
      requestId,
      ip,
      userAgent,
    });
    // O degrau que ACABOU de nascer tem evento próprio (issue #4743): quem lê a
    // auditoria depois precisa distinguir "errou a senha" de "a conta entrou em
    // bloqueio de 30 minutos" sem inferir nada.
    if (degrau) {
      await audit({
        action: degrau.acao,
        metadata: {
          email_hash: hashEmail(parsed.data.email),
          falhas_no_dia: await falhasNaJanelaDiaria(parsed.data.email),
          castigo_seg: degrau.segundos,
        },
        requestId,
        ip,
        userAgent,
      });
    }
    return { ok: false, error: "invalid_credentials" };
  }

  // Entrar de novo é o jeito que a pessoa tem de "atualizar" o que vê. O cache
  // curto de autorização só é derrubado por quem escreve PELO APP; vínculo
  // gravado por fora (seed, worker, SQL) esperaria o TTL. Um MISS por login.
  invalidarUsuario(data.user.id);

  // MFA gating — if the user has any verified TOTP factor enrolled, they must
  // complete the challenge in /login/mfa before reaching the app.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const verifiedTotp = factorsData?.totp?.find((f) => f.status === "verified");
  const confiavel =
    !!verifiedTotp && !!data.session && (await reconhecerDispositivoConfiavel(data.user.id, verifiedTotp.id, data.session.access_token));
  if (verifiedTotp && !confiavel) {
    return { ok: false, error: "mfa_required", challengeId: verifiedTotp.id };
  }

  await audit({
    action: "auth.login_success",
    actorUserId: data.user.id,
    metadata: confiavel ? { mfa: "dispositivo_confiavel" } : {},
    requestId,
    ip,
    userAgent,
  });

  // Server-side redirect ensures fresh session cookie is sent to browser.
  redirect(safeNext(next, "/app"));
}
