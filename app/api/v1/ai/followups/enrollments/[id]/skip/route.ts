import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/skip (manager+) — pula o passo em
 * que o follow-up está e o coloca no passo seguinte, para ser avaliado no
 * próximo tick.
 *
 * Body opcional: `{ "edge_id": "<id da saída>" }`. Um nó pode ter mais de uma
 * saída (o de classificação tem uma por classe) e escolher a de maior
 * prioridade no automático seria decidir pelo operador o rumo do atendimento —
 * com mais de um caminho, a rota devolve 422 com as opções e quem clica escolhe.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { pulaPassoDoEnrollment } from "@/lib/followup/intervencao";
import { respostaDaFalha } from "@/lib/followup/intervencao-resposta";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { validaIdDaRota } from "../_id";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ edge_id: z.string().min(1).max(200).optional() });

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
  const { user, org } = authz;

  // Body ausente é legítimo aqui (nó de saída única não precisa de escolha), então
  // JSON ilegível degrada para "sem escolha", não para 400.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", "Caminho inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const resultado = await pulaPassoDoEnrollment(
    { supabase: await createClient(), admin: createAdminClient(), orgId: org.orgId, userId: user.id, requestId },
    id,
    parsed.data.edge_id ?? null,
  );
  if (!resultado.ok) return respostaDaFalha(resultado, requestId);

  void audit({
    action: "followup_enrollment.step_skipped",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: { de: resultado.enrollment.current_node_id, edge_id: parsed.data.edge_id ?? null },
  });

  return ok({ id, status: resultado.status_novo, next_eval_at: resultado.next_eval_at }, { requestId });
}
