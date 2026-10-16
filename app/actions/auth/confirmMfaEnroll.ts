"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";

export type ConfirmMfaEnrollResult =
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error: "invalid_code" | "challenge_failed" | "verify_failed"; message?: string };

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

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: "challenge_failed", message: challengeErr?.message };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) {
    return { ok: false, error: "verify_failed", message: verifyErr.message };
  }

  // Generate + hash 10 recovery codes.
  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({
    user_id: user.id,
    code_hash: hashRecoveryCode(c),
  }));

  // Try user-scoped first (RLS policy `recovery_codes_self` permits insert
  // where user_id = auth.uid()). Fall back to admin if RLS rejects (e.g. AAL
  // policy mismatch).
  let { error: insertErr } = await supabase.from("user_recovery_codes").insert(rows);
  if (insertErr && isServiceRoleConfigured()) {
    const admin = createAdminClient();
    const r = await admin.from("user_recovery_codes").insert(rows);
    insertErr = r.error;
  }
  if (insertErr) {
    console.error("[confirmMfaEnroll] failed to insert recovery codes:", insertErr.message);
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
