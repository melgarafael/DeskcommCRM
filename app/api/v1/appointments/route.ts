import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  lead_id: z.string().uuid(),
  appointment_type_id: z.string().uuid(),
  scheduled_at: z.string().datetime(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const from = url.searchParams.get("from"); // ISO
  const to = url.searchParams.get("to"); // ISO
  const responsibleUserId = url.searchParams.get("responsible_user_id");
  const leadId = url.searchParams.get("lead_id");

  const admin = createAdminClient();
  let query = admin
    .from("appointments")
    .select("id, lead_id, appointment_type_id, responsible_user_id, scheduled_at, duration_minutes, status")
    .eq("organization_id", authz.org.orgId);

  if (from) query = query.gte("scheduled_at", from);
  if (to) query = query.lt("scheduled_at", to);
  if (responsibleUserId) query = query.eq("responsible_user_id", responsibleUserId);
  if (leadId) query = query.eq("lead_id", leadId);
  query = query.order("scheduled_at", { ascending: true });

  const { data, error } = await query;
  if (error) return fail("internal_error", "Erro ao listar agendamentos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "appointments" });
  if (!authz.ok) return authz.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();

  const { data: type, error: typeErr } = await admin
    .from("appointment_types")
    .select("duration_minutes, responsible_user_id")
    .eq("id", parsed.data.appointment_type_id)
    .eq("organization_id", authz.org.orgId)
    .single();
  if (typeErr || !type) return fail("not_found", "Tipo de agendamento não encontrado.", 404, { requestId });

  const { data: created, error: createErr } = await admin
    .from("appointments")
    .insert({
      organization_id: authz.org.orgId,
      lead_id: parsed.data.lead_id,
      appointment_type_id: parsed.data.appointment_type_id,
      responsible_user_id: (type as { responsible_user_id: string }).responsible_user_id,
      scheduled_at: parsed.data.scheduled_at,
      duration_minutes: (type as { duration_minutes: number }).duration_minutes,
      created_by_user_id: authz.user.id,
    })
    .select("id")
    .single();

  if (createErr) {
    // 23P01 = exclusion_violation — a fonte de verdade final contra corrida
    // (duas abas marcando o mesmo horário do mesmo responsável ao mesmo tempo).
    if ((createErr as { code?: string }).code === "23P01") {
      return fail(
        "schedule_conflict",
        "Este horário já está ocupado para o responsável deste tipo de agendamento.",
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao criar agendamento.", 500, { requestId });
  }
  const appointmentId = (created as { id: string }).id;

  // Vínculo lead↔agendamento — `target_kind='appointment'` já reservado no
  // CHECK de `crm_lead_links`, nunca usado até aqui (DIRC: referenciar, não duplicar).
  // `link_kind` é `text not null` sem default; "reference" segue o precedente
  // existente (target_kind='external' + link_kind='reference').
  const { error: linkErr } = await admin.from("crm_lead_links").insert({
    organization_id: authz.org.orgId,
    lead_id: parsed.data.lead_id,
    target_kind: "appointment",
    target_id: appointmentId,
    link_kind: "reference",
  });
  if (linkErr) {
    logger.warn("[appointments] crm_lead_links insert falhou", {
      error: linkErr.message,
      appointment_id: appointmentId,
      lead_id: parsed.data.lead_id,
      requestId,
    });
  }

  const activityResult = await emitLeadActivity(admin as never, {
    organizationId: authz.org.orgId,
    leadId: parsed.data.lead_id,
    type: "appointment_scheduled",
    sourceModule: "agenda",
    sourceId: appointmentId,
    actor: { type: "user", id: authz.user.id },
    reason: `Agendamento marcado para ${new Date(parsed.data.scheduled_at).toLocaleString("pt-BR")}`,
  });
  if (!activityResult.ok) {
    logger.warn("[appointments] emitLeadActivity falhou", {
      error: activityResult.error,
      appointment_id: appointmentId,
      lead_id: parsed.data.lead_id,
      requestId,
    });
  }

  void audit({
    action: "appointment.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "appointments",
    resourceId: appointmentId,
    requestId,
    metadata: { lead_id: parsed.data.lead_id, scheduled_at: parsed.data.scheduled_at },
  });

  return ok({ id: appointmentId }, { status: 201, requestId });
}
