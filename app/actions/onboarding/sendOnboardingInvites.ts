"use server";

/**
 * Server Action: bulk-invite teammates from the onboarding wizard.
 *
 * Reuses the canonical invite token + email template (EPIC-09) directly so
 * we don't pay the cost of a self-call to the API route. Failures to send
 * email do NOT block onboarding progression.
 */
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/smtp";
import { marcaDaSaida } from "@/lib/branding/saida";
import { inviteOnboardingSchema } from "@/lib/schemas/onboarding";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

type PapelHumano = "viewer" | "agent" | "manager" | "admin";

export type SendInvitesResult =
  | {
      ok: true;
      sent: number;
      failed: number;
      /** Convites cujo email NÃO saiu (ex.: SMTP não configurado) — o link
       * de aceite é devolvido para o admin enviar manualmente. */
      undelivered?: { email: string; accept_url: string }[];
    }
  | { ok: false; error: "auth_required" | "no_active_org" | "invalid_input"; details?: unknown };

interface InvitePayload {
  // Convite é para PESSOA: só papel humano. `ai_operator` não entra aqui de
  // propósito — é papel de token de agente, ninguém o recebe por e-mail.
  invitations: { email: string; role: PapelHumano }[];
  skip?: boolean;
}

export async function sendOnboardingInvites(payload: InvitePayload): Promise<SendInvitesResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  if (payload.skip) {
    await patchOnboardingState(ctx.orgId, { team: { invites_sent: 0, skipped: true } });
    await audit({
      action: "onboarding.team_invited",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      metadata: { skipped: true, count: 0 },
    });
    redirect("/onboarding");
  }

  let input;
  try {
    input = inviteOnboardingSchema.parse(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  // env.* é runtime → correto na imagem genérica self-host (ver browser.ts).
  const baseUrl = env.NEXT_PUBLIC_APP_URL;
  const inviterName = ctx.fullName ?? ctx.email ?? "Um colega";
  // Fora do laço: a marca é a mesma para o lote inteiro (mesma organização).
  const marca = await marcaDaSaida(ctx.orgId);

  let sent = 0;
  let failed = 0;
  const undelivered: { email: string; accept_url: string }[] = [];
  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();
    const inviteId = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS;
    const token = signInviteToken({
      invite_id: inviteId,
      email,
      organization_id: ctx.orgId,
      role: inv.role,
      exp,
    });
    const acceptUrl = `${baseUrl.replace(/\/$/, "")}/team/accept-invite/${token}`;
    const expiresAt = new Date(exp * 1000);
    const { subject, html, text } = buildInviteEmail({
      inviterName,
      orgName: ctx.orgName,
      acceptUrl,
      role: inv.role,
      expiresAt,
      marca,
    });
    const result = await sendEmail({
      to: email,
      subject,
      html,
      text,
      fromName: marca.nome,
      tags: [
        { name: "kind", value: "team_invite" },
        { name: "src", value: "onboarding" },
        { name: "org", value: ctx.orgId },
      ],
    });
    if (result.ok) sent += 1;
    else {
      failed += 1;
      undelivered.push({ email, accept_url: acceptUrl });
    }

    await audit({
      action: "member.invited",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
      resourceType: "membership",
      resourceId: inviteId,
      metadata: {
        email,
        role: inv.role,
        email_dispatched: result.ok,
        source: "onboarding",
      },
    });
  }

  await patchOnboardingState(ctx.orgId, {
    team: { invites_sent: sent + failed, skipped: false },
  });
  await audit({
    action: "onboarding.team_invited",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    metadata: { count: sent + failed, sent, failed },
  });

  // Email falhou (ex.: VPS sem SMTP completo): NÃO redireciona em silêncio —
  // devolve os links de aceite pro admin enviar manualmente (mesmo contrato do
  // fallback de /app/team/invite). Redirect só no caminho 100% entregue.
  if (failed > 0) {
    return { ok: true, sent, failed, undelivered };
  }

  redirect("/onboarding");
}
