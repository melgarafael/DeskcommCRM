"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/auth/schemas";
import { audit } from "@/lib/audit";

export type UpdatePasswordResult = {
  ok: false;
  error: "validation_error" | "session_expired" | "same_password" | "update_failed";
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
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    if (/different from the old password/i.test(error.message)) {
      return { ok: false, error: "same_password" };
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
