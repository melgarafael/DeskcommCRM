"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { sessionAal } from "@/lib/auth/server";
import { invalidarUsuario } from "@/lib/auth/cache-curto";

export type ConfirmMfaEnrollResult =
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error: "invalid_code" | "challenge_failed" | "verify_failed"; message?: string }
  | { ok: false; error: "mfa_required" | "service_unavailable" | "recovery_codes_failed" };

/**
 * Confirms a TOTP enrollment by issuing a challenge + verifying the code, then
 * generates 10 single-use recovery codes (sha256-hashed, stored as bytea).
 *
 * Recovery codes are returned ONCE to the caller for display — never stored
 * plaintext. Caller is responsible for showing them to the user with copy /
 * download / acknowledge UX.
 */
export async function confirmMfaEnroll(
  code: string,
  factorId: string,
): Promise<ConfirmMfaEnrollResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: "invalid_code" };
  }

  // A mesma régua de `enrollMfa`: com um fator verificado, confirmar outro (e
  // receber códigos de recuperação) exige o atual provado nesta sessão.
  const { data: fatores, error: listErr } = await supabase.auth.mfa.listFactors();
  // Sem a lista não dá para saber se a conta já tem fator: recusa em vez de
  // tratar como primeiro cadastro.
  if (listErr) return { ok: false, error: "challenge_failed", message: listErr.message };
  const temFatorVerificado = fatores?.all?.some(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );
  if (temFatorVerificado && (await sessionAal()) !== "aal2") {
    return { ok: false, error: "mfa_required" };
  }

  // Os códigos só são gravados pelo client de serviço (migration 0755). Sem ele,
  // recusa ANTES de verificar o fator: depois, o fator ficaria ativo sem códigos.
  if (!isServiceRoleConfigured()) return { ok: false, error: "service_unavailable" };

  // Gerados antes do desafio pelo mesmo motivo: se o hash não puder ser feito,
  // a falha vem antes de o fator ficar ativo.
  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({ user_id: user.id, code_hash: hashRecoveryCode(c) }));

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeErr || !challenge) {
    // Mesma razão de `enrollMfa`: o motivo fica no servidor (#3161). O `code`
    // do TOTP não entra — só o código de erro do provedor e o motivo.
    logger.error("[mfa-confirmacao] o provedor recusou o desafio do fator", {
      factor_id: factorId,
      code: challengeErr?.code,
      error: challengeErr?.message,
    });
    return { ok: false, error: "challenge_failed", message: challengeErr?.message };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) {
    // Aqui é onde o código de 6 dígitos é recusado: o motivo do provedor é a
    // única pista de que o relógio do celular, o fator ou a janela do desafio
    // são o problema. O código TOTP em si NUNCA entra no log — nem o segredo.
    logger.error("[mfa-confirmacao] o provedor recusou o código do fator", {
      factor_id: factorId,
      code: verifyErr.code,
      error: verifyErr.message,
    });
    return { ok: false, error: "verify_failed", message: verifyErr.message };
  }
  // As outras sessões da pessoa passam a dever a prova agora, não em 30 s.
  invalidarUsuario(user.id);

  // Substitui o conjunto anterior: os códigos mostrados agora são os únicos que valem.
  const admin = createAdminClient();
  const { error: delErr } = await admin.from("user_recovery_codes").delete().eq("user_id", user.id);
  const { error: insertErr } = delErr
    ? { error: delErr }
    : await admin.from("user_recovery_codes").insert(rows);
  if (insertErr) {
    // O fator já foi verificado. Repetir a confirmação grava os códigos (a sessão
    // está em aal2 agora); mostrar códigos que não foram gravados seria pior.
    logger.error("[mfa-confirmacao] não gravou os códigos de recuperação", {
      factor_id: factorId,
      error: insertErr.message,
    });
    return { ok: false, error: "recovery_codes_failed" };
  }

  await audit({
    action: "auth.mfa_enrolled",
    actorUserId: user.id,
    metadata: { recovery_codes_generated: codes.length },
    requestId,
    ip,
    userAgent,
  });

  return { ok: true, recovery_codes: codes };
}
