/**
 * PATCH  /api/v1/mensagens-agendadas/[id] — edita um agendamento pendente
 *        (texto, horário e o que fazer com o número fora do ar).
 * DELETE /api/v1/mensagens-agendadas/[id] — cancela um agendamento pendente.
 *
 * As duas conferem pela SESSÃO que o agendamento é visível (a policy exige a
 * conversa visível) antes de escrever com o service role.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { editarAgendamentoSchema, horarioNoFuturo } from "@/lib/agendamento-mensagem/schema";

export const dynamic = "force-dynamic";

/**
 * Filtro do UPDATE: o cron não está com o agendamento nas mãos. Editar ou cancelar
 * no meio do envio deixaria a linha dizendo uma coisa e a mensagem outra.
 */
function semEnvioEmCurso(): string {
  return `claimed_until.is.null,claimed_until.lt.${new Date().toISOString()}`;
}

/** O agendamento existe, é desta organização e a sessão enxerga a conversa dele? */
async function visivelPelaSessao(id: string, orgId: string): Promise<boolean | "erro"> {
  const sessao = await createClient();
  const { data, error } = await sessao
    .from("mensagens_agendadas")
    .select("id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return "erro";
  return data !== null;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "id inválido.", 422, { requestId });

  const parsed = editarAgendamentoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os campos do agendamento.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const v = parsed.data;
  if (!horarioNoFuturo(v.scheduled_at)) {
    return fail("validation_failed", "Escolha um horário no futuro.", 422, { requestId, details: { motivo: "horario_no_passado" } });
  }

  const orgId = auth.org.orgId;
  const visivel = await visivelPelaSessao(id, orgId);
  if (visivel === "erro") return fail("internal_error", "Erro ao ler o agendamento.", 500, { requestId });
  if (!visivel) return fail("not_found", "Agendamento não encontrado, já terminado ou saindo agora.", 404, { requestId });

  const { data, error } = await createAdminClient()
    .from("mensagens_agendadas")
    .update({
      title: v.title ?? null,
      body: v.body,
      scheduled_at: v.scheduled_at,
      se_desconectado: v.se_desconectado,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", orgId)
    .eq("status", "agendada")
    .or(semEnvioEmCurso())
    .select("id, scheduled_at, status")
    .maybeSingle();
  if (error) return fail("internal_error", "Não consegui salvar a edição.", 500, { requestId });
  if (!data) return fail("not_found", "Agendamento não encontrado, já terminado ou saindo agora.", 404, { requestId });

  void audit({
    action: "scheduled_message.updated",
    organizationId: orgId,
    actorUserId: auth.user.id,
    resourceType: "mensagens_agendadas",
    resourceId: id,
    requestId,
    metadata: { scheduled_at: v.scheduled_at },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "id inválido.", 422, { requestId });

  const orgId = auth.org.orgId;
  const visivel = await visivelPelaSessao(id, orgId);
  if (visivel === "erro") return fail("internal_error", "Erro ao ler o agendamento.", 500, { requestId });
  if (!visivel) return fail("not_found", "Agendamento não encontrado, já terminado ou saindo agora.", 404, { requestId });

  const { data, error } = await createAdminClient()
    .from("mensagens_agendadas")
    .update({ status: "cancelada", motivo: "cancelada_pelo_atendente", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", orgId)
    .eq("status", "agendada")
    .or(semEnvioEmCurso())
    .select("id");
  if (error) return fail("internal_error", "Não consegui cancelar o agendamento.", 500, { requestId });
  if (!data?.length) return fail("not_found", "Agendamento não encontrado, já terminado ou saindo agora.", 404, { requestId });

  void audit({
    action: "scheduled_message.cancelled",
    organizationId: orgId,
    actorUserId: auth.user.id,
    resourceType: "mensagens_agendadas",
    resourceId: id,
    requestId,
  });
  return ok({ id, status: "cancelada" }, { requestId });
}
