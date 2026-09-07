import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/pause (manager+) — segura o
 * follow-up sem matá-lo. O enrollment sai do relógio (`paused_manual`, sem
 * `next_eval_at`), então `fn_claim_due_followup_enrollments` deixa de vê-lo, e
 * a caminhada fica exatamente onde estava.
 *
 * A regra e a corrida contra o motor estão em `lib/followup/intervencao.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { pausaEnrollment } from "@/lib/followup/intervencao";
import { respostaDaFalha } from "@/lib/followup/intervencao-resposta";
import { traduzir } from "@/lib/i18n/dicionario";
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
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const resultado = await pausaEnrollment(
    { supabase: await createClient(), admin: createAdminClient(), orgId: org.orgId, userId: user.id, requestId },
    id,
  );
  if (!resultado.ok) return respostaDaFalha(resultado, requestId, t);

  void audit({
    action: "followup_enrollment.paused",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: { previous_status: resultado.enrollment.status, node_id: resultado.enrollment.current_node_id },
  });

  return ok({ id, status: resultado.status_novo, next_eval_at: resultado.next_eval_at }, { requestId });
}
