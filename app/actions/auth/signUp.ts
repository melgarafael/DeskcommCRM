"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import {
  signupSchema,
  signupComConviteSchema,
  type SignupInput,
  type SignupComConviteInput,
} from "@/lib/auth/schemas";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createRegistrationRequest, notifyRegistrationApprovers, registrationIntentFromMetadata } from "@/lib/auth/registration-requests";

export type SignUpResult =
  | {
      ok: true;
      /**
       * O provedor de auth JÁ abriu a sessão neste `signUp()` — quer dizer,
       * "Confirm email" está DESLIGADO nele e não vai existir link nenhum para
       * clicar. Quem chama precisa saber disto: a tela de "confirme seu e-mail"
       * é uma instrução impossível de cumprir nesse estado, e a pessoa fica
       * esperando para sempre um e-mail que nunca sai — autenticada, sem
       * organização, sem motivo para navegar até a saída que existe.
       *
       * Medido em 2026-09-05 na `origin/main` @ `4d50f63f`, com
       * `GOTRUE_MAILER_AUTOCONFIRM=true`: a tela dizia "Enviamos um link de
       * confirmação para …", e ao mesmo tempo o cookie `sb-deskcomm-auth`
       * estava no browser e `user_organizations` do usuário vinha `[]`.
       *
       * Achado de @KIRAzinx566, com um cliente real travado nessa tela.
       */
      sessao_ativa: boolean;
      /**
       * O convite pode ser concluído automaticamente: o link assinado e o
       * e-mail do convite já são a prova de posse; o SMTP só entrega o link.
       */
      aceitar_convite_automaticamente?: boolean;
      aguardando_aprovacao?: boolean;
    }
  | {
      ok: false;
      error: "validation_error" | "rate_limited" | "signup_failed";
      details?: Record<string, unknown>;
    };

/**
 * Signup self-service: cria o usuário no GoTrue e dispara o e-mail de
 * confirmação. O tenant só é provisionado quando o link é confirmado em
 * /auth/confirm (evita orgs órfãs de cadastros nunca confirmados).
 *
 * Anti-enumeração: e-mail já cadastrado recebe a MESMA resposta de sucesso —
 * o GoTrue devolve um usuário ofuscado (identities vazio) sem erro, e nós não
 * diferenciamos. Rate limit de envio de e-mail é do próprio GoTrue.
 */
export async function signUp(
  input: SignupInput | SignupComConviteInput,
  /**
   * Token de convite, quando a conta está sendo criada para ACEITAR um convite.
   * Viaja até `/auth/confirm` pelo `user_metadata` — o mesmo canal que
   * `org_name` já usa e que o e2e do signup exercita. Ele não dá acesso a nada
   * sozinho: quem decide é `decidirConviteDoSignup`, comparando a assinatura do
   * token com o e-mail que o provedor de auth confirmou.
   */
  inviteToken?: string,
): Promise<SignUpResult> {
  const temConvite = typeof inviteToken === "string" && inviteToken.trim() !== "";
  const parsed = temConvite
    ? signupComConviteSchema.safeParse(input)
    : signupSchema.safeParse(input);
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
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  // Criar conta é fluxo raro por pessoa: teto baixo por IP evita fábrica de
  // organizações (cada signup provisiona tenant). Issue #64.
  if (await authRateLimited("signup", null, AUTH_LIMITS.signup)) {
    return { ok: false, error: "rate_limited" };
  }

  // Só vira convite se o token verificar E for para este e-mail. Divergência
  // aqui não é erro do usuário — é tentativa de entrar em organização alheia
  // colando um token que chegou para outra pessoa.
  let convite: string | null = null;
  if (temConvite && inviteToken) {
    const payload = verifyInviteToken(inviteToken);
    if (!payload) {
      return { ok: false, error: "validation_error", details: { invite: ["convite_invalido"] } };
    }
    if (payload.email.trim().toLowerCase() !== parsed.data.email.trim().toLowerCase()) {
      return { ok: false, error: "validation_error", details: { invite: ["email_divergente"] } };
    }
    convite = inviteToken;
  }

  const supabase = await createClient();
  // O convite é uma credencial HMAC emitida pelo administrador. Se o usuário
  // chegou por esse link e criou a senha para o e-mail assinado, não depende
  // de um segundo e-mail SMTP para concluir o acesso. Isso também cobre
  // o caso em que o SMTP tem configuração, mas recusou o remetente
  // e o sistema devolveu o link copiável ao administrador.
  const confirmarConvitePorLink = Boolean(convite);
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Ver comentário equivalente em requestPasswordReset.ts: ?type=signup
      // sobrevive ao redirect do GoTrue e é o que distingue este fluxo do de
      // recovery quando a verificação chega via `code` (PKCE), não `token_hash`.
      emailRedirectTo: `${origin}/auth/confirm?type=signup`,
      // O convite é revalidado no servidor mesmo tendo sido validado ao montar
      // a tela: o campo de e-mail do formulário é adulterável no cliente, e a
      // decisão que importa acontece com o e-mail JÁ confirmado pelo provedor.
      data: convite
        ? { invite_token: convite }
        : {
            registration_kind: (parsed.data as SignupInput).registration_kind,
            org_name: (parsed.data as SignupInput).org_name,
            requested_organization_id: (parsed.data as SignupInput).requested_organization_id,
          },
    },
  });

  if (error) {
    if (error.status === 429) return { ok: false, error: "rate_limited" };
    await audit({
      action: "auth.signup_failed",
      metadata: {
        email_hash: hashEmail(parsed.data.email),
        reason: error.message,
      },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "signup_failed" };
  }

  await audit({
    action: "auth.signup_requested",
    actorUserId: data.user?.id ?? null,
    metadata: { email_hash: hashEmail(parsed.data.email) },
    requestId,
    ip,
    userAgent,
  });

  if (!confirmarConvitePorLink && data.user) {
    const intent = registrationIntentFromMetadata(data.user.user_metadata);
    if (!intent) return { ok: false, error: "signup_failed" };
    try {
      const admin = createAdminClient();
      const { error: confirmError } = await admin.auth.admin.updateUserById(data.user.id, { email_confirm: true });
      if (confirmError) return { ok: false, error: "signup_failed" };
      const request = await createRegistrationRequest(data.user.id, intent);
      // A falta de SMTP não impede a fila: a aprovação continua disponível na tela.
      void notifyRegistrationApprovers(intent, parsed.data.email);
      await audit({
        action: "registration.requested",
        actorUserId: data.user.id,
        resourceType: "registration_request",
        resourceId: request.id ?? undefined,
        requestId,
        ip,
        userAgent,
        metadata: { kind: intent.kind, created: request.created },
      });
      return { ok: true, sessao_ativa: Boolean(data.session), aguardando_aprovacao: true };
    } catch {
      return { ok: false, error: "signup_failed" };
    }
  }

  // No convite, o token já foi validado acima contra o e-mail do formulário.
  // Fazemos isso para um usuário novo ou para a conta pendente criada por uma
  // tentativa anterior deste mesmo convite. Uma conta já confirmada nunca é
  // alterada por este caminho, preservando anti-enumeração e segurança.
  if (
    confirmarConvitePorLink &&
    data.user &&
    !data.session
  ) {
    const admin = createAdminClient();
    const isNewUser = (data.user.identities?.length ?? 0) > 0;
    let canComplete = isNewUser;
    if (!isNewUser) {
      const { data: existing } = await admin.auth.admin.getUserById(data.user.id);
      canComplete = Boolean(
        existing.user &&
        !existing.user.email_confirmed_at &&
        existing.user.email?.trim().toLowerCase() === parsed.data.email.trim().toLowerCase(),
      );
    }
    if (!canComplete) {
      return { ok: true, sessao_ativa: false };
    }

    const { error: confirmError } = await admin.auth.admin.updateUserById(data.user.id, {
      email_confirm: true,
      password: parsed.data.password,
    });
    if (confirmError) {
      await audit({
        action: "auth.signup_failed",
        actorUserId: data.user.id,
        metadata: { email_hash: hashEmail(parsed.data.email), reason: "invite_auto_confirm_failed" },
        requestId,
        ip,
        userAgent,
      });
      return { ok: false, error: "signup_failed" };
    }

    const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (signInError || !signedIn.session) {
      await audit({
        action: "auth.signup_failed",
        actorUserId: data.user.id,
        metadata: { email_hash: hashEmail(parsed.data.email), reason: "invite_auto_signin_failed" },
        requestId,
        ip,
        userAgent,
      });
      return { ok: false, error: "signup_failed" };
    }

    return {
      ok: true,
      sessao_ativa: true,
      aceitar_convite_automaticamente: true,
    };
  }

  // `data.session` é o único sinal confiável de que o provedor não vai mandar
  // e-mail nenhum: ele vem preenchido exatamente quando a confirmação está
  // desligada (ou já resolvida) e o GoTrue devolveu tokens junto do usuário.
  return confirmarConvitePorLink
    ? { ok: true, sessao_ativa: data.session !== null, aceitar_convite_automaticamente: data.session !== null }
    : { ok: true, sessao_ativa: data.session !== null };
}
