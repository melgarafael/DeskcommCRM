/**
 * GET /api/v1/team/invites — convites da organização ativa (migration 0238).
 *
 * O que a aba "Membros" da tela de Equipe não mostrava: convite enviado,
 * pendente, expirado ou revogado — e se o e-mail chegou a sair. Manager+ lê
 * (RLS `team_invites_select`); as ações (reenviar / revogar) são admin.
 *
 * `status` é derivado aqui, não vem do banco. `accept_url` só acompanha convite
 * em aberto (pendente/expirado) — é o link copiável que o admin usa quando o
 * e-mail não saiu.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import {
  conviteEstaEmAberto,
  linkDeAceite,
  statusConvite,
  type ConviteDeTime,
} from "@/lib/team/convites";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("team_invites")
    .select(
      "id, organization_id, email, role, interface_settings, invited_by, inviter_name, email_dispatched, created_at, last_sent_at, resend_count, expires_at, accepted_at, revoked_at",
    )
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const now = Date.now();
  const invites = ((rows ?? []) as ConviteDeTime[]).map((row) => {
    const status = statusConvite(row, now);
    return {
      ...row,
      status,
      accept_url: conviteEstaEmAberto(row, now) ? linkDeAceite(row) : null,
    };
  });

  return ok(invites, { requestId });
}
