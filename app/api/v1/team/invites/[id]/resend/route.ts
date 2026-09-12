/**
 * POST /api/v1/team/invites/[id]/resend — reenvia um convite pendente.
 *
 * admin-only. Re-assina o token com o mesmo `invite_id`, dispara o e-mail de
 * novo e renova a validade (24h a partir de agora). Audita `member.invited`
 * pelo admin que clicou — é uma nova emissão do mesmo convite.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { reenviarConvite, statusConvite, type ConviteDeTime } from "@/lib/team/convites";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  if (!z.string().uuid().safeParse(id).success) {
    return fail("invalid_request", t("Convite inválido."), 400, { requestId });
  }
  if (!isServiceRoleConfigured()) {
    return fail("unavailable", t("Envio de e-mail não configurado nesta instalação."), 503, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const { data: row, error: readErr } = await admin
    .from("team_invites")
    .select(
      "id, organization_id, email, role, interface_settings, invited_by, inviter_name, email_dispatched, created_at, last_sent_at, resend_count, expires_at, accepted_at, revoked_at",
    )
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });
  if (!row) return fail("not_found", t("Convite não encontrado."), 404, { requestId });

  const convite = row as ConviteDeTime;
  const status = statusConvite(convite);
  if (status === "aceito") {
    return fail("state_conflict", t("Este convite já foi aceito."), 409, { requestId });
  }
  if (status === "revogado") {
    return fail("state_conflict", t("Este convite foi revogado. Envie um novo."), 409, {
      requestId,
    });
  }

  const resultado = await reenviarConvite(admin, {
    convite,
    orgName: activeOrg.name,
    actorId: authUser.id,
    actorName: authUser.full_name ?? authUser.email ?? "Um colega",
    requestId,
  });
  if (!resultado) {
    return fail("state_conflict", t("O convite mudou. Atualize e tente de novo."), 409, {
      requestId,
    });
  }

  return ok(
    {
      ...resultado.convite,
      status: statusConvite(resultado.convite),
      accept_url: resultado.accept_url,
      email_dispatched: resultado.email_dispatched,
    },
    { requestId },
  );
}
