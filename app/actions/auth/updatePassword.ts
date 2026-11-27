"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { logger } from "@/lib/logger";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/auth/schemas";
import { audit } from "@/lib/audit";
import {
  bloqueioProgressivoDeConta,
  liberarBloqueioProgressivo,
  mfaBloqueadoPorFalhas,
  registrarFalhaDeMfa,
} from "@/lib/auth/rate-limit";
import { loadAuthUser } from "@/lib/auth/server";
import { permanentAccessError } from "@/lib/impersonate/support";

export type UpdatePasswordResult = {
  ok: false;
  error:
    | "validation_error"
    | "session_expired"
    | "same_password"
    | "password_too_long"
    | "update_failed"
    | "mfa_required"
    | "mfa_invalid"
    | "mfa_locked";
  details?: Record<string, unknown>;
};

/**
 * Define a nova senha dentro da sessão de recovery (estabelecida pelo link do
 * e-mail via /auth/confirm). Ao concluir, encerra a sessão e redireciona para
 * /login?reset=success — o usuário prova a senha nova num login limpo.
 */
export async function updatePassword(
  input: ResetPasswordInput,
): Promise<UpdatePasswordResult> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "session_expired" };

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  // Conta com MFA: a sessão de recovery entra em AAL1, mas o GoTrue recusa a
  // troca de senha em AAL1 quando há fator verificado ("AAL2 session is
  // required..."). Elevamos para AAL2 com um challenge TOTP antes do update.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal1" && aal?.nextLevel === "aal2") {
    if (!parsed.data.mfa_code) return { ok: false, error: "mfa_required" };
    // Mesmo balde por usuário do verifyMfa: o código conferido aqui é o mesmo.
    if (await mfaBloqueadoPorFalhas(user.id)) return { ok: false, error: "mfa_locked" };
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const totp = factors?.totp?.[0];
    if (!totp) return { ok: false, error: "update_failed" };
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
      factorId: totp.id,
    });
    if (chErr || !challenge) return { ok: false, error: "mfa_invalid" };
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId: totp.id,
      challengeId: challenge.id,
      code: parsed.data.mfa_code,
    });
    if (verifyErr) {
      await registrarFalhaDeMfa(user.id);
      return { ok: false, error: "mfa_invalid" };
    }
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    if (/different from the old password/i.test(error.message)) {
      return { ok: false, error: "same_password" };
    }
    // O bcrypt corta em 72 bytes: o schema já recusa o caso normal, mas a
    // versão do GoTrue pode divergir da nossa régua. Causa conhecida tem
    // código próprio — não cai no genérico.
    if (/cannot be longer than 72 characters/i.test(error.message)) {
      return { ok: false, error: "password_too_long" };
    }
    await audit({
      action: "auth.password_reset_failed",
      actorUserId: user.id,
      metadata: { reason: error.message },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "update_failed" };
  }

  await limparSenhaProvisoria(supabase, user.id, requestId);

  // O DESBLOQUEIO (issue #4743, item 1). Este é o caminho real medido no
  // produto: `/login` → "esqueci a senha" → link do e-mail → `/auth/confirm`
  // (sessão de recuperação) → é aqui que a senha nova é gravada. Sem esta
  // limpeza, o castigo de 30 minutos seguraria a conta DEPOIS de o dono já ter
  // provado que controla o e-mail e trocado a senha.
  const emailDaConta = user.email ?? null;
  if (emailDaConta) {
    const antes = await bloqueioProgressivoDeConta(emailDaConta);
    await liberarBloqueioProgressivo(emailDaConta);
    if (antes.bloqueado) {
      await audit({
        action: "auth.login_bloqueio_removido",
        actorUserId: user.id,
        // Sem o e-mail, nem em hash: a linha já tem o `actorUserId`, e o
        // evento responde "a conta destravou e por quê", não "de quem é".
        metadata: { degrau: antes.degrau },
        requestId,
        ip,
        userAgent,
      });
    }
  }

  await audit({
    action: "auth.password_reset_completed",
    actorUserId: user.id,
    metadata: {},
    requestId,
    ip,
    userAgent,
  });

  await supabase.auth.signOut();
  redirect("/login?reset=success");
}

/**
 * A pessoa acabou de escolher a própria senha, então a senha provisória
 * (#3876) deixou de valer: a marca sai, a mesma garantia da troca do primeiro
 * acesso. Sem isto, quem recuperou a senha ainda passava pela tela de troca.
 *
 * A leitura é com a sessão (a RLS mostra à pessoa os próprios vínculos); a
 * escrita é com o cliente de serviço, porque a sessão não escreve a marca
 * (gatilho da migration 9381). A senha nova já valeu: uma falha aqui é
 * registrada e não desfaz a recuperação — o pior caso é uma troca a mais.
 */
async function limparSenhaProvisoria(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  requestId: string | null,
): Promise<void> {
  // A marca mora no vínculo, e vínculo não se escreve em acompanhamento (a regra
  // é uma só, `permanentAccessError`). Quem acompanha não tem vínculo marcado.
  if (permanentAccessError((await loadAuthUser())?.support)) return;
  const { data: marcados, error: leErr } = await supabase
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("senha_provisoria", true);
  const orgs = (marcados ?? []).map((v) => v.organization_id as string);
  if (leErr || orgs.length === 0) {
    if (leErr) {
      logger.error("recuperação: marca da senha provisória não pôde ser lida", {
        user_id: userId,
        request_id: requestId,
        code: leErr.code,
      });
    }
    return;
  }
  const { error } = await createAdminClient()
    .from("user_organizations")
    .update({ senha_provisoria: false })
    .in("organization_id", orgs)
    .eq("user_id", userId)
    .eq("senha_provisoria", true);
  if (error) {
    logger.error("recuperação: senha trocada, mas a marca da senha provisória não caiu", {
      user_id: userId,
      request_id: requestId,
      code: error.code,
    });
    return;
  }
  invalidarUsuario(userId);
}
