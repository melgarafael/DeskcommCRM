"use server";
/**
 * Server Action: accept a team invite token.
 *
 * Steps:
 *   1. Verify HMAC token (signature + expiry).
 *   2. Get current authenticated user from cookie session.
 *   3. Email mismatch → return error (UI tells user to sign out / use the right account).
 *   4. INSERT user_organizations (organization_id, user_id, role, accepted_at, invited_by=null).
 *      If a revoked row already exists for (user, org), reactivate it instead.
 *   5. Audit `member.accepted` and redirect to /app/inbox.
 */
import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { createClient } from "@/lib/supabase/server";

export type AcceptInviteResult =
  | { ok: true }
  | { ok: false; error: "invalid_or_expired" | "email_mismatch" | "not_authenticated" | "internal_error"; message?: string; expectedEmail?: string };

export async function acceptInviteAction(token: string): Promise<AcceptInviteResult> {
  const payload = verifyInviteToken(token);
  if (!payload) return { ok: false, error: "invalid_or_expired" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "not_authenticated" };

  const userEmail = (user.email ?? "").trim().toLowerCase();
  const inviteEmail = payload.email.trim().toLowerCase();
  if (userEmail !== inviteEmail) {
    return { ok: false, error: "email_mismatch", expectedEmail: payload.email };
  }

  // Reactivate or insert. Use upsert-like flow: check existing membership first.
  const { data: existing, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, revoked_at")
    .eq("user_id", user.id)
    .eq("organization_id", payload.organization_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: "internal_error", message: fetchErr.message };
  }

  const nowIso = new Date().toISOString();

  if (existing?.id) {
    const { error: updErr } = await supabase
      .from("user_organizations")
      .update({
        role: payload.role,
        revoked_at: null,
        accepted_at: existing.revoked_at ? nowIso : (nowIso),
        updated_at: nowIso,
      })
      .eq("id", existing.id);
    if (updErr) return { ok: false, error: "internal_error", message: updErr.message };

    await audit({
      action: "member.accepted",
      actorUserId: user.id,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: existing.id,
      metadata: { invite_id: payload.invite_id, role: payload.role, reactivated: !!existing.revoked_at },
    });
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from("user_organizations")
      .insert({
        user_id: user.id,
        organization_id: payload.organization_id,
        role: payload.role,
        invited_at: new Date(payload.exp * 1000 - 24 * 60 * 60 * 1000).toISOString(),
        accepted_at: nowIso,
      })
      .select("id")
      .single();
    if (insErr) return { ok: false, error: "internal_error", message: insErr.message };

    await audit({
      action: "member.accepted",
      actorUserId: user.id,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: inserted.id,
      metadata: { invite_id: payload.invite_id, role: payload.role },
    });
  }

  redirect("/app/inbox");
}
