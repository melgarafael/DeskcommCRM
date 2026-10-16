"use server";

import { headers } from "next/headers";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";

export type RegenerateRecoveryCodesResult =
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error: string };

/**
 * Deletes existing user_recovery_codes for the current user and issues 10
 * fresh codes. Plaintext returned ONCE — never persisted.
 */
export async function regenerateRecoveryCodes(): Promise<RegenerateRecoveryCodesResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // Confirm user has a verified TOTP factor (regenerate is meaningless otherwise).
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasFactor = factors?.totp?.some((f) => f.status === "verified");
  if (!hasFactor) return { ok: false, error: "mfa_not_enrolled" };

  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({ user_id: user.id, code_hash: hashRecoveryCode(c) }));

  // Delete + insert. Use admin client when available (RLS for delete may be
  // tighter than insert). Fall back to user-scoped.
  let delErr: unknown = null;
  let insErr: unknown = null;
  if (isServiceRoleConfigured()) {
    const admin = createAdminClient();
    const d = await admin.from("user_recovery_codes").delete().eq("user_id", user.id);
    delErr = d.error;
    if (!delErr) {
      const ins = await admin.from("user_recovery_codes").insert(rows);
      insErr = ins.error;
    }
  } else {
    const d = await supabase.from("user_recovery_codes").delete().eq("user_id", user.id);
    delErr = d.error;
    if (!delErr) {
      const ins = await supabase.from("user_recovery_codes").insert(rows);
      insErr = ins.error;
    }
  }
  if (delErr) {
    const msg = (delErr as { message?: string }).message ?? "delete_failed";
    return { ok: false, error: msg };
  }
  if (insErr) {
    const msg = (insErr as { message?: string }).message ?? "insert_failed";
    return { ok: false, error: msg };
  }

  await audit({
    action: "mfa.recovery_codes_regenerated",
    actorUserId: user.id,
    resourceType: "user",
    resourceId: user.id,
    requestId,
    ip,
    userAgent,
    metadata: { count: codes.length },
  });

  return { ok: true, recovery_codes: codes };
}
