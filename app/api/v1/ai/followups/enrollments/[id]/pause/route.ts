/**
 * POST /api/v1/ai/followups/enrollments/:id/pause (manager+) — segura o
 * follow-up sem matá-lo. O enrollment sai do relógio (`paused_manual`, sem
 * `next_eval_at`), então `fn_claim_due_followup_enrollments` deixa de vê-lo, e
 * a caminhada fica exatamente onde estava.
 *
 * A regra e a corrida contra o motor estão em `lib/followup/intervencao.ts`.
 *
 * Sessão OU token de integração (Spec 33, R1): `config:write` e papel admin
 * (`tokenRole`); a organização sai de `authz.organizationId`. No ramo do token
 * o `userId` é null (não existe pessoa) e o `apiTokenId` vai no evento e no
 * audit; o cliente é a service role, e todo `organization_id` é escrito à mão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { pausaEnrollment } from "@/lib/followup/intervencao";
import { respostaDaFalha } from "@/lib/followup/intervencao-resposta";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { validaIdDaRota } from "../_id";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const invalido = validaIdDaRota(id, requestId);
  if (invalido) return invalido;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_enrollments",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_enrollments", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { organizationId } = authz;
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;

  const resultado = await pausaEnrollment(
    {
      supabase: authz.supabase,
      admin: createAdminClient(),
      orgId: organizationId,
      userId: actorUserId,
      apiTokenId: authz.apiTokenId ?? null,
      requestId,
    },
    id,
  );
  if (!resultado.ok) return respostaDaFalha(resultado, requestId, t);

  void audit({
    action: "followup_enrollment.paused",
    actorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: { previous_status: resultado.enrollment.status, node_id: resultado.enrollment.current_node_id },
  });

  return ok({ id, status: resultado.status_novo, next_eval_at: resultado.next_eval_at }, { requestId });
}
