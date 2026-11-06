"use server";

/**
 * Server Action: bulk-invite teammates from the onboarding wizard.
 *
 * ─── POR QUE ELA USA `emitirConvite` ─────────────────────────────────────────
 * O que viaja no e-mail é um token HMAC stateless, mas a aba **Membros** da tela
 * de Equipe não lista tokens: lista LINHAS de `team_invites`, e é delas que saem
 * o "Não saiu", o **Copiar link**, o reenvio e a **revogação**. Assinar o token
 * aqui e não gravar a linha fazia o convite do onboarding existir só no link que
 * apareceu na tela: quem fechasse a aba sem copiar não tinha onde recuperar nem
 * como cancelar o acesso (#4055).
 *
 * O caminho canônico é `emitirConvite` — o MESMO de `/app/team/invite`: assina o
 * token, dispara o e-mail, audita `member.invited` e grava/renova a linha. O
 * `id` da linha é o `invite_id` do token, então o link copiado aqui é aceito e
 * revogado como qualquer outro. Reconvidar o mesmo e-mail RENOVA a linha
 * pendente (índice único parcial), não duplica.
 *
 * Sem service-role a action degrada para só-token — igual à rota canônica: o
 * link continua valendo, só não há linha para listar.
 *
 * O wizard não pergunta a interface (menu) do convidado; o convite nasce com a
 * interface completa, que é o default do caminho canônico. Falha de e-mail NÃO
 * bloqueia o onboarding: os links voltam em `undelivered` para o admin copiar.
 */
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { issueInvite } from "@/lib/auth/issue-invite";
import { inviteOnboardingSchema } from "@/lib/schemas/onboarding";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitirConvite } from "@/lib/team/convites";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

type PapelHumano = "viewer" | "agent" | "manager" | "admin";

export type SendInvitesResult =
  | {
      ok: true;
      sent: number;
      failed: number;
      /** Convites cujo email NÃO saiu (ex.: nenhum transporte configurado) — o link
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

  const requestId = randomUUID();
  const inviterName = ctx.fullName ?? ctx.email ?? "Um colega";
  // Mesma degradação da rota canônica: sem service-role não há onde gravar a
  // linha, e o convite segue como só-token em vez de a action estourar.
  const admin = isServiceRoleConfigured() ? createAdminClient() : null;

  let sent = 0;
  let failed = 0;
  const undelivered: { email: string; accept_url: string }[] = [];
  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();
    // `emitirConvite` audita `member.invited` (com `request_id`) e grava a
    // linha; não há um segundo audit por convite aqui de propósito.
    const emitido = admin
      ? await emitirConvite(admin, {
          organizationId: ctx.orgId,
          orgName: ctx.orgName,
          email,
          role: inv.role,
          inviterId: ctx.userId,
          inviterName,
          requestId,
        })
      : await issueInvite({
          email,
          role: inv.role,
          organizationId: ctx.orgId,
          orgName: ctx.orgName,
          inviterId: ctx.userId,
          inviterName,
          requestId,
        });

    if (emitido.email_dispatched) sent += 1;
    else {
      failed += 1;
      undelivered.push({ email, accept_url: emitido.accept_url });
    }
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

  // Email falhou (ex.: VPS sem SMTP e sem Resend): NÃO redireciona em silêncio —
  // devolve os links de aceite pro admin enviar manualmente (mesmo contrato do
  // fallback de /app/team/invite). Redirect só no caminho 100% entregue.
  if (failed > 0) {
    return { ok: true, sent, failed, undelivered };
  }

  redirect("/onboarding");
}
