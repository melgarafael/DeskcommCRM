import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/team/[user_id]/reactivate — devolve o acesso de um membro revogado.
 *
 * ─── Por que esta rota precisou existir ─────────────────────────────────────
 *
 * Revogar era uma porta que só abria por fora. Medido numa instalação real em
 * 2026-09-10, com uma pessoa de verdade do outro lado: quem administra revoga,
 * o membro some da lista, e a ÚNICA forma de devolvê-lo era emitir um convite
 * novo — que o RPC aceita (ele limpa `revoked_at` quando o convite é posterior
 * à revogação), mas cujo caminho é longo e cheio de beco: quem já tem conta é
 * empurrado para "Criar conta", que falha com *"Tente novamente"* e nunca vai
 * funcionar; e quem entra pelo login cai na tela de acesso revogado, que só
 * oferece Sair.
 *
 * Reativar é o inverso exato de revogar, e este arquivo é o espelho de
 * `../revoke/route.ts` — mesmos guardrails, mesma forma de resposta, mesma
 * trilha.
 *
 * ─── Por que NÃO reaproveita `fn_accept_team_invite` ────────────────────────
 *
 * Aquela função existe para o ACEITE, e o aceite é ato de quem foi convidado:
 * ela exige um convite assinado, compara com `revoked_at` e grava
 * `accepted_at = now()`. Aqui quem age é quem ADMINISTRA, sobre um vínculo que
 * já foi aceito um dia. Passar por lá exigiria emitir um convite que ninguém
 * vai receber, e reescreveria a data de aceite — apagando quando a pessoa de
 * fato entrou na equipe.
 *
 * ─── O que esta rota NÃO faz ────────────────────────────────────────────────
 *
 * Não devolve papel diferente do que a pessoa tinha. Reativar é desfazer a
 * revogação, não promover: trocar papel já tem rota própria
 * (`../role/route.ts`), e juntar as duas faria uma reativação distraída virar
 * promoção silenciosa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const supabase = await createClient();

  const { data: target, error: fetchErr } = await supabase
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!target) return fail("not_found", t("Membro não encontrado."), 404, { requestId });

  // Idempotente, na mesma forma que `revoke` usa para o caso simétrico: dois
  // cliques seguidos não podem virar erro na cara de quem administra.
  if (!target.revoked_at) {
    return ok({ user_id: targetUserId, already_active: true }, { requestId });
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("user_organizations")
    .update({ revoked_at: null, updated_at: nowIso })
    .eq("id", target.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "member.reactivated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: target.id,
    requestId,
    metadata: { target_user_id: targetUserId, restored_role: target.role },
  });

  return ok({ user_id: targetUserId, reactivated_at: nowIso }, { requestId });
}
