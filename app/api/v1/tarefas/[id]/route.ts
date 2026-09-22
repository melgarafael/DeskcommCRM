/**
 * PATCH /api/v1/tarefas/[id] — conclui/cancela, edita, registra check-in.
 *
 * Concluir carimba `concluida_em`; check-in carimba lugar + hora juntos
 * (lugar sem hora não prova visita). Reabrir é voltar para pendente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_TAREFA, tarefaPatchSchema } from "@/lib/schemas/tarefas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "commercial_tasks" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const parsed = tarefaPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.status !== undefined) {
    patch.status = parsed.data.status;
    patch.concluida_em = parsed.data.status === "concluida" ? new Date().toISOString() : null;
  }
  if (parsed.data.titulo !== undefined) patch.titulo = parsed.data.titulo;
  if (parsed.data.descricao !== undefined) patch.descricao = parsed.data.descricao;
  if (parsed.data.agendada_para !== undefined) patch.agendada_para = parsed.data.agendada_para;
  if (parsed.data.checkin_lat != null || parsed.data.checkin_lng != null) {
    if (parsed.data.checkin_lat != null) patch.checkin_lat = parsed.data.checkin_lat;
    if (parsed.data.checkin_lng != null) patch.checkin_lng = parsed.data.checkin_lng;
    patch.checkin_em = new Date().toISOString();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("commercial_tasks")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DA_TAREFA)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao salvar a tarefa.", 500, { requestId });
  if (!data) return fail("not_found", "Tarefa não encontrada.", 404, { requestId });

  if (parsed.data.status === "concluida") {
    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "commercial_task.concluida",
      resourceType: "commercial_tasks",
      resourceId: id,
      requestId,
    });
  }

  return ok(data, { requestId });
}
