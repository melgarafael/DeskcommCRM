import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/resume (manager+) — devolve ao
 * relógio o follow-up que uma pessoa pausou.
 *
 * A espera volta pelo que FALTAVA quando a pausa começou, não pela data
 * original: segurar por uma semana um fluxo que ia falar em 4h devolve 4h de
 * espera, e não uma mensagem imediata. O restante foi congelado no evento da
 * pausa (`lib/followup/intervencao.ts`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { retomaEnrollment } from "@/lib/followup/intervencao";
import { respostaDaFalha } from "@/lib/followup/intervencao-resposta";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { validaIdDaRota } from "../_id";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const invalido = validaIdDaRota(id, requestId);
  if (invalido) return invalido;

  const authz = await requireRole("manager", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const resultado = await retomaEnrollment(
    { supabase: await createClient(), admin: createAdminClient(), orgId: org.orgId, userId: user.id, requestId },
    id,
  );
  if (!resultado.ok) return respostaDaFalha(resultado, requestId);

  void audit({
    action: "followup_enrollment.resumed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: { status: resultado.status_novo, next_eval_at: resultado.next_eval_at },
  });

  return ok({ id, status: resultado.status_novo, next_eval_at: resultado.next_eval_at }, { requestId });
}
