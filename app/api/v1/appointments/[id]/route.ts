import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(["scheduled", "completed", "cancelled", "no_show"]).optional(),
  scheduled_at: z.string().datetime().optional(),
});

const ACTIVITY_BY_STATUS: Record<string, ActivityType> = {
  completed: "appointment_completed",
  cancelled: "appointment_cancelled",
  no_show: "appointment_no_show",
};

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("invalid_request", "Nenhum campo para atualizar.", 400, { requestId });
  }

  const patch: Record<string, unknown> = { ...parsed.data };
  const isReschedule = parsed.data.scheduled_at !== undefined;
  // Reagendar zera reminder_sent_at — senão um agendamento remarcado pra
  // longe nunca recebe lembrete novo (o cron só olha `is null`).
  if (isReschedule) patch.reminder_sent_at = null;

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("appointments")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id, lead_id, status, scheduled_at")
    .single();

  if (error) {
    // 23P01 = exclusion_violation — a constraint é `FOR ALL`, então também
    // dispara em UPDATE (não só em INSERT como na criação).
    if ((error as { code?: string }).code === "23P01") {
      return fail("schedule_conflict", "O novo horário colide com outro agendamento do responsável.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao atualizar agendamento.", 500, { requestId });
  }
  const row = updated as { id: string; lead_id: string; status: string; scheduled_at: string };

  if (isReschedule) {
    const activityResult = await emitLeadActivity(admin as never, {
      organizationId: authz.org.orgId,
      leadId: row.lead_id,
      type: "appointment_rescheduled",
      sourceModule: "agenda",
      sourceId: row.id,
      actor: { type: "user", id: authz.user.id },
      reason: `Agendamento remarcado para ${new Date(row.scheduled_at).toLocaleString("pt-BR")}`,
    });
    if (!activityResult.ok) {
      logger.warn("[appointments] emitLeadActivity (rescheduled) falhou", {
        error: activityResult.error,
        appointment_id: row.id,
        lead_id: row.lead_id,
        requestId,
      });
    }

    // audit() já é fire-and-forget e captura seus próprios erros
    // internamente (nunca rejeita) — void aqui segue o mesmo padrão do
    // POST em app/api/v1/appointments/route.ts.
    void audit({
      action: "appointment.rescheduled",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "appointments",
      resourceId: row.id,
      requestId,
      metadata: { scheduled_at: row.scheduled_at },
    });
  }

  if (parsed.data.status !== undefined && ACTIVITY_BY_STATUS[parsed.data.status]) {
    const activityResult = await emitLeadActivity(admin as never, {
      organizationId: authz.org.orgId,
      leadId: row.lead_id,
      type: ACTIVITY_BY_STATUS[parsed.data.status]!,
      sourceModule: "agenda",
      sourceId: row.id,
      actor: { type: "user", id: authz.user.id },
      reason: `Status do agendamento mudou para ${parsed.data.status}`,
    });
    if (!activityResult.ok) {
      logger.warn("[appointments] emitLeadActivity (status_changed) falhou", {
        error: activityResult.error,
        appointment_id: row.id,
        lead_id: row.lead_id,
        requestId,
      });
    }

    void audit({
      action: "appointment.status_changed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "appointments",
      resourceId: row.id,
      requestId,
      metadata: { status: parsed.data.status },
    });
  }

  return ok(row, { requestId });
}
