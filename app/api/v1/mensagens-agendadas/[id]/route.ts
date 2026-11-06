/**
 * PATCH  /api/v1/mensagens-agendadas/[id] — edita um agendamento pendente.
 *        Recebe os mesmos campos da criação. Contato e número ficam os originais.
 * DELETE /api/v1/mensagens-agendadas/[id] — cancela a série. O histórico de envios fica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarAgendamentoSchema, motivoRegraInvalida, regraDoCorpo } from "@/lib/agendamento-mensagem/schema";
import { primeiraOcorrencia } from "@/lib/agendamento-mensagem/recorrencia";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "id inválido.", 422, { requestId });

  const parsed = criarAgendamentoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os campos do agendamento.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const v = parsed.data;
  const regra = regraDoCorpo(v);
  const motivo = motivoRegraInvalida(regra);
  if (motivo) return fail("validation_failed", "Confira a recorrência e as datas.", 422, { requestId, details: { motivo } });

  const orgId = auth.org.orgId;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("mensagens_agendadas")
    .update({
      title: v.title ?? null,
      body: v.body,
      recorrencia: v.recorrencia,
      intervalo_dias: v.intervalo_dias ?? null,
      inicio_local: v.inicio_local,
      termino_local: v.termino_local ?? null,
      tz: v.tz,
      scheduled_at: primeiraOcorrencia(regra).toISOString(),
      se_desconectado: v.se_desconectado,
      claimed_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", orgId)
    .eq("status", "agendada")
    .select("id, scheduled_at, status")
    .maybeSingle();
  if (error) return fail("internal_error", "Não consegui salvar a edição.", 500, { requestId });
  if (!data) return fail("not_found", "Agendamento não encontrado ou já terminado.", 404, { requestId });

  void audit({
    action: "scheduled_message.updated",
    organizationId: orgId,
    actorUserId: auth.user.id,
    resourceType: "mensagens_agendadas",
    resourceId: id,
    requestId,
    metadata: { recorrencia: v.recorrencia },
  });
  return ok(data, { requestId });
}

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "id inválido.", 422, { requestId });

  const { data, error } = await createAdminClient()
    .from("mensagens_agendadas")
    .update({ status: "cancelada", claimed_until: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", auth.org.orgId)
    .eq("status", "agendada")
    .select("id");
  if (error) return fail("internal_error", "Não consegui cancelar o agendamento.", 500, { requestId });
  if (!data?.length) return fail("not_found", "Agendamento não encontrado ou já terminado.", 404, { requestId });

  void audit({
    action: "scheduled_message.cancelled",
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    resourceType: "mensagens_agendadas",
    resourceId: id,
    requestId,
  });
  return ok({ id, status: "cancelada" }, { requestId });
}
