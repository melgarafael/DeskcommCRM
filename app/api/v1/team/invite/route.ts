/**
 * POST /api/v1/team/invite — bulk-invite up to 20 emails.
 *
 * Pragmatic MVP: invitations are stateless HMAC tokens (no team_invites table).
 * If a user with that email already has an active membership in the org, we
 * skip with reason `already_member`. Otherwise we sign a 24h token containing
 * a fresh invite_id (uuid) + email + org_id + role and email the link.
 *
 * Membership row is created at /accept-invite time (Server Action) — that's
 * also when audit emits `member.accepted`. Here we audit `member.invited`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { env } from "@/lib/env";
import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { inviteMemberSchema, validateRequest } from "@/lib/schemas";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/resend";

export const dynamic = "force-dynamic";

interface SentItem {
  email: string;
  invite_id: string;
  expires_at: string;
  email_dispatched: boolean;
  accept_url: string;
}
interface FailedItem {
  email: string;
  reason: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(inviteMemberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const sent: SentItem[] = [];
  const failed: FailedItem[] = [];

  const admin = isServiceRoleConfigured() ? createAdminClient() : null;
  // env.* parseia process.env em runtime → funciona na imagem genérica self-host
  // (não fica queimado no bundle como process.env.NEXT_PUBLIC_APP_URL direto).
  const baseUrl = env.NEXT_PUBLIC_APP_URL;
  const inviterName = authUser.full_name ?? authUser.email ?? "Um colega";

  // Emails com membership ATIVA na org — para pular o reconvite de quem já é membro.
  // O schema `auth` NÃO é acessível via PostgREST (erro "Invalid schema: auth"), então
  // resolvemos email↔usuário pela GoTrue admin API (getUserById) — mesmo padrão de
  // app/api/v1/team/route.ts. N pequeno (poucos membros por org no perfil BPO).
  const memberEmails = new Set<string>();
  if (admin) {
    const { data: members } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", activeOrg.orgId)
      .is("revoked_at", null);
    for (const m of members ?? []) {
      const { data: u } = await admin.auth.admin.getUserById(m.user_id as string);
      const memberEmail = u?.user?.email?.trim().toLowerCase();
      if (memberEmail) memberEmails.add(memberEmail);
    }
  }

  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();

    // já é membro ativo → pula (não reenvia convite)
    if (memberEmails.has(email)) {
      failed.push({ email, reason: "already_member" });
      continue;
    }

    const inviteId = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS;
    const token = signInviteToken({
      invite_id: inviteId,
      email,
      organization_id: activeOrg.orgId,
      role: inv.role,
      exp,
    });
    const acceptUrl = `${baseUrl.replace(/\/$/, "")}/team/accept-invite/${token}`;
    const expiresAt = new Date(exp * 1000);

    const { subject, html, text } = buildInviteEmail({
      inviterName,
      orgName: activeOrg.name,
      acceptUrl,
      role: inv.role,
      expiresAt,
    });

    const result = await sendEmail({
      to: email,
      subject,
      html,
      text,
      tags: [
        { name: "kind", value: "team_invite" },
        { name: "org", value: activeOrg.orgId },
      ],
    });

    sent.push({
      email,
      invite_id: inviteId,
      expires_at: expiresAt.toISOString(),
      email_dispatched: result.ok,
      accept_url: acceptUrl,
    });

    await audit({
      action: "member.invited",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "membership",
      resourceId: inviteId,
      requestId,
      metadata: {
        email,
        role: inv.role,
        email_dispatched: result.ok,
        email_error: result.ok ? null : (result.error ?? null),
      },
    });
  }

  return ok({ sent, failed }, { status: 201, requestId });
}
