import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET /auth/confirm — troca o token do e-mail por uma sessão.
 *
 * É o destino único dos links de e-mail do GoTrue: confirmação de signup E
 * redefinição de senha. Dois formatos de link chegam aqui, dependendo de como
 * o projeto Supabase está configurado:
 *
 * - `token_hash` + `type`: template de e-mail customizado (supabase/templates/)
 *   linkando direto pro app — exige SMTP customizado configurado no painel
 *   (sem isso o Supabase não deixa editar o corpo do e-mail).
 * - `code` (PKCE): template PADRÃO do Supabase (nenhum SMTP customizado
 *   configurado — caso mais comum em instalação fresca). O e-mail linka pro
 *   `/auth/v1/verify` do próprio GoTrue, que valida e SÓ ENTÃO redireciona pra
 *   cá com o code; não inclui `type`, por isso requestPasswordReset.ts e
 *   signUp.ts anexam `?type=` no redirectTo/emailRedirectTo — é o único jeito
 *   desse dado sobreviver ao hop pelo GoTrue nesse formato.
 *
 * - type=signup  → provisiona o tenant (org + membership admin) e entra no
 *                  onboarding. Provisionamento é idempotente (link clicado 2x).
 * - type=recovery → sessão de recovery estabelecida; segue para /login/reset
 *                  onde o usuário define a senha nova.
 *
 * Fluxo canônico do @supabase/ssr: verifyOtp/exchangeCodeForSession grava os
 * cookies de sessão via cookies() do next/headers; o Next anexa os Set-Cookie
 * ao redirect retornado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const requestId = request.headers.get("x-request-id");

  // NUNCA usar url.origin aqui: é derivado do header Host, que o proxy/container
  // pode entregar como o bind interno (ex.: 0.0.0.0:3000) em vez do domínio
  // público — o link de recovery quebra silenciosamente para o usuário final.
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  if (!(tokenHash && type) && !code) {
    return redirectTo("/login?error=link_invalido");
  }

  const supabase = await createClient();
  const { data, error } =
    tokenHash && type
      ? await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
      : await supabase.auth.exchangeCodeForSession(code as string);

  if (error || !data.user) {
    await audit({
      action: "auth.email_link_rejected",
      metadata: { type, reason: error?.message ?? "no_user" },
      requestId,
    });
    return redirectTo("/login?error=link_invalido");
  }

  if (type === "recovery") {
    return redirectTo("/login/reset");
  }

  try {
    await ensureTenantForUser(data.user);
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: data.user.id,
      metadata: { reason: e instanceof Error ? e.message : String(e) },
      requestId,
    });
    return redirectTo("/login?error=provisionamento");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: data.user.id,
    metadata: {},
    requestId,
  });

  return redirectTo("/onboarding/welcome");
}
