/**
 * Convite de time como REGISTRO, não só como token.
 *
 * O token HMAC (`lib/auth/invite-token.ts`) continua sendo o que viaja no
 * e-mail e o que o aceite verifica. `team_invites` (migration 0238) é a linha
 * que espelha esse convite enquanto ele está pendente — é o que a tela de
 * Equipe lista, o que diz se o e-mail saiu, e o que torna possível REVOGAR
 * (cancelar um token stateless exige algo contra o que verificar no aceite).
 *
 * O `id` da linha É o `invite_id` que vai dentro do token. Reconvidar um e-mail
 * que já tem convite pendente RENOVA a mesma linha (o índice único parcial
 * garante no máximo um pendente por e-mail por organização).
 *
 * STATUS é derivado, nunca coluna: `statusConvite()` decide a partir de
 * `revoked_at` / `accepted_at` / `expires_at`.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { issueInvite } from "@/lib/auth/issue-invite";
import { signInviteToken } from "@/lib/auth/invite-token";
import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  type InterfaceSettings,
} from "@/lib/navigation/interface";
import type { Role } from "@/lib/schemas/team";
import {
  conviteEstaEmAberto,
  statusConvite,
  type CamposDeStatus,
  type StatusConvite,
} from "@/lib/team/convite-status";

export { conviteEstaEmAberto, statusConvite };
export type { CamposDeStatus, StatusConvite };

export interface ConviteDeTime {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  interface_settings: InterfaceSettings;
  invited_by: string | null;
  inviter_name: string | null;
  email_dispatched: boolean;
  created_at: string;
  last_sent_at: string;
  resend_count: number;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

/**
 * Reconstrói o link de aceite de uma linha pendente. O token é stateless — não
 * o guardamos —, então re-assinamos com os campos da linha. Qualquer token
 * válido com o mesmo `invite_id` serve; o aceite verifica assinatura, validade,
 * e-mail e revogação.
 */
export function linkDeAceite(row: ConviteDeTime): string {
  const token = signInviteToken({
    invite_id: row.id,
    email: row.email,
    organization_id: row.organization_id,
    role: row.role,
    iat: Math.floor(Date.parse(row.last_sent_at) / 1000),
    exp: Math.floor(Date.parse(row.expires_at) / 1000),
    invited_by: row.invited_by ?? undefined,
    interface_settings: row.interface_settings,
  });
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;
}

interface EmitirParams {
  organizationId: string;
  orgName: string;
  email: string;
  role: Role;
  interfaceSettings?: InterfaceSettings;
  inviterId: string;
  inviterName: string;
  requestId: string;
}

export interface ResultadoEmissao {
  convite: ConviteDeTime;
  accept_url: string;
  email_dispatched: boolean;
  /** true = renovou uma linha pendente que já existia (reenvio). */
  renovado: boolean;
}

/**
 * Emite (ou renova) um convite: assina o token, dispara o e-mail, audita
 * `member.invited` (tudo dentro de `issueInvite`) e grava/atualiza a linha em
 * `team_invites`. Requer o client service-role — a linha é escrita ignorando
 * RLS e filtrando `organization_id` da fonte confiável (nunca do body).
 */
export async function emitirConvite(
  admin: SupabaseClient,
  params: EmitirParams,
): Promise<ResultadoEmissao> {
  const email = params.email.trim().toLowerCase();
  const interfaceSettings = interfaceSettingsSchema.parse(
    params.interfaceSettings ?? INTERFACE_COMPLETA,
  );

  const { data: pendente } = await admin
    .from("team_invites")
    .select("id, resend_count")
    .eq("organization_id", params.organizationId)
    .eq("email", email)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .maybeSingle();

  const inviteId = (pendente?.id as string | undefined) ?? randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);

  const emitido = await issueInvite({
    email,
    role: params.role,
    interfaceSettings,
    organizationId: params.organizationId,
    orgName: params.orgName,
    inviterId: params.inviterId,
    inviterName: params.inviterName,
    requestId: params.requestId,
    inviteId,
    issuedAt,
  });

  const nowIso = new Date().toISOString();
  const base = {
    organization_id: params.organizationId,
    email,
    role: params.role,
    interface_settings: interfaceSettings,
    invited_by: params.inviterId,
    inviter_name: params.inviterName,
    email_dispatched: emitido.email_dispatched,
    last_sent_at: nowIso,
    expires_at: emitido.expires_at,
  };

  const { data: row, error } = pendente
    ? await admin
        .from("team_invites")
        .update({ ...base, resend_count: (pendente.resend_count as number) + 1 })
        .eq("id", inviteId)
        .select("*")
        .single()
    : await admin
        .from("team_invites")
        .insert({ id: inviteId, ...base })
        .select("*")
        .single();

  if (error) throw error;

  return {
    convite: row as ConviteDeTime,
    accept_url: emitido.accept_url,
    email_dispatched: emitido.email_dispatched,
    renovado: !!pendente,
  };
}

/**
 * Reenvia um convite que já existe: re-assina o token com o `invite_id` da
 * linha, dispara o e-mail de novo, audita `member.invited` (via `issueInvite`)
 * pelo ator que clicou reenviar, e renova `expires_at` / `last_sent_at` /
 * `resend_count`. Preserva `invited_by` — o convite continua sendo de quem o
 * abriu; reenviar é só re-entrega.
 *
 * Retorna `null` se a linha deixou de estar em aberto entre a leitura e a
 * escrita (corrida com um aceite ou uma revogação).
 */
export async function reenviarConvite(
  admin: SupabaseClient,
  params: {
    convite: ConviteDeTime;
    orgName: string;
    actorId: string;
    actorName: string;
    requestId: string;
  },
): Promise<ResultadoEmissao | null> {
  const { convite } = params;
  const emitido = await issueInvite({
    email: convite.email,
    role: convite.role,
    interfaceSettings: convite.interface_settings,
    organizationId: convite.organization_id,
    orgName: params.orgName,
    inviterId: params.actorId,
    inviterName: params.actorName,
    requestId: params.requestId,
    inviteId: convite.id,
    issuedAt: Math.floor(Date.now() / 1000),
  });

  const { data: row, error } = await admin
    .from("team_invites")
    .update({
      email_dispatched: emitido.email_dispatched,
      last_sent_at: new Date().toISOString(),
      expires_at: emitido.expires_at,
      resend_count: convite.resend_count + 1,
    })
    .eq("id", convite.id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!row) return null;

  return {
    convite: row as ConviteDeTime,
    accept_url: emitido.accept_url,
    email_dispatched: emitido.email_dispatched,
    renovado: true,
  };
}
