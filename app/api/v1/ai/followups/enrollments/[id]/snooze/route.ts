import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/snooze (manager+) — remarca o
 * próximo passo para o horário que a pessoa escolheu, sem tirar o follow-up do
 * relógio nem mudar o passo em que ele está.
 *
 * Body: `{ "next_eval_at": "<ISO>" }` — futuro e no máximo 90 dias, o mesmo
 * teto do nó de espera do construtor (`waitConfigSchema`).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { adiaEnrollment } from "@/lib/followup/intervencao";
import { respostaDaFalha } from "@/lib/followup/intervencao-resposta";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { validaIdDaRota } from "../_id";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ next_eval_at: z.string().min(1) });

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const invalido = validaIdDaRota(id, requestId);
  if (invalido) return invalido;

  const authz = await requireRole("manager", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Informe o novo horário."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const resultado = await adiaEnrollment(
    { supabase: await createClient(), admin: createAdminClient(), orgId: org.orgId, userId: user.id, requestId },
    id,
    parsed.data.next_eval_at,
  );
  if (!resultado.ok) return respostaDaFalha(resultado, requestId, t);

  void audit({
    action: "followup_enrollment.snoozed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: { de: resultado.enrollment.next_eval_at, para: resultado.next_eval_at },
  });

  return ok({ id, status: resultado.status_novo, next_eval_at: resultado.next_eval_at }, { requestId });
}
