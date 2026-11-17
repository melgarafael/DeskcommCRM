import { z } from "zod";
import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/api/handlers/types";
import { hashDoCorpo } from "@/lib/api/idempotency";

const statuses = {
  scheduled: "confirmed",
  confirmed: "confirmed",
  arrived: "confirmed",
  in_attendance: "confirmed",
  done: "completed",
  canceled: "cancelled",
  missed: "no_show",
} as const;
export type RemoteStatus = keyof typeof statuses;
export function localStatusForAmigo(status: string) {
  if (!(status in statuses)) throw new Error("Estado de consulta Amigo não reconhecido.");
  return statuses[status as RemoteStatus];
}
const remoteAttendance = z
  .object({
    id: z.number().int().positive(),
    patient_id: z.number().int().positive(),
    event_id: z.number().int().positive(),
    start_date: z.string(),
    end_date: z.string(),
    status: z
      .enum(["scheduled", "confirmed", "arrived", "in_attendance", "done", "canceled", "missed"])
      .optional(),
    canceled: z.boolean().optional(),
    done: z.boolean().optional(),
    missed: z.boolean().optional(),
    confirmed_at: z.string().nullable().optional(),
    arrived: z.string().nullable().optional(),
    in_attendance: z.boolean().nullable().optional(),
    is_arrival_order: z.boolean().optional(),
    shift: z.string().optional(),
    arrival_start_time: z.string().optional(),
    arrival_end_time: z.string().optional(),
    timegrids: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
    user_id: z.number().optional(),
    place_id: z.number().nullable().optional(),
    user: z
      .object({ id: z.number(), name: z.string(), config_arrival_order: z.boolean().optional() })
      .optional(),
    patient: z.object({ id: z.number(), name: z.string() }).optional(),
    place: z
      .object({ id: z.number(), name: z.string(), address: z.string().optional() })
      .optional(),
    agenda_event: z.object({ id: z.number(), name: z.string() }).optional(),
    event: z.object({ id: z.number(), name: z.string() }).optional(),
  })
  .passthrough();

/** Parse civil timestamps using the clinic timezone; never the host's timezone. */
export function amigoInstant(value: string, timezone: string): string {
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error("Data Amigo inválida.");
    return date.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("Data Amigo sem formato reconhecido.");
  const [, y, m, d, h, minute, second] = match;
  const date = instanteDe(
    {
      ano: Number(y),
      mes: Number(m),
      dia: Number(d),
      hora: Number(h),
      minuto: Number(minute),
      segundo: Number(second ?? 0),
    },
    timezone,
  );
  const wall = partesNoFuso(date, timezone);
  if (
    wall.ano !== Number(y) ||
    wall.mes !== Number(m) ||
    wall.dia !== Number(d) ||
    wall.hora !== Number(h) ||
    wall.minuto !== Number(minute) ||
    wall.segundo !== Number(second ?? 0)
  )
    throw new Error("Horário inexistente no fuso da clínica.");
  return date.toISOString();
}

export function normalizeAttendance(input: unknown, timezone: string) {
  const row = remoteAttendance.parse(input);
  const status: RemoteStatus =
    row.status ??
    (row.canceled
      ? "canceled"
      : row.done
        ? "done"
        : row.missed
          ? "missed"
          : row.in_attendance
            ? "in_attendance"
            : row.arrived
              ? "arrived"
              : row.confirmed_at
                ? "confirmed"
                : "scheduled");
  const startsAt = amigoInstant(row.start_date, timezone);
  const endsAt = amigoInstant(row.end_date, timezone);
  if (endsAt <= startsAt) throw new Error("Intervalo de consulta Amigo inválido.");
  return {
    remoteId: row.id,
    patientId: row.patient_id,
    eventId: row.event_id,
    doctorId: row.user?.id ?? row.user_id ?? null,
    doctorName: row.user?.name ?? null,
    placeId: row.place?.id ?? row.place_id ?? null,
    placeName: row.place?.name ?? null,
    patientName: row.patient?.name ?? null,
    title: row.agenda_event?.name ?? row.event?.name ?? "Consulta Amigo",
    startsAt,
    endsAt,
    remoteStatus: status,
    localStatus: localStatusForAmigo(status),
    arrivalOrder: row.is_arrival_order ?? row.user?.config_arrival_order ?? false,
    shift: row.shift ?? null,
    arrivalStart: row.arrival_start_time ?? row.timegrids?.[0]?.start ?? null,
    arrivalEnd: row.arrival_end_time ?? row.timegrids?.at(-1)?.end ?? null,
    arrivalWindows: row.timegrids ?? [],
    address: row.place?.address ?? row.place?.name ?? null,
  };
}

export interface ProjectionConnection {
  id: string;
  organizationId: string;
  timezone: string;
}

/** The remote ID owns the link; the link UUID owns its single local projection. */
export async function projectAttendance(
  db: SupabaseClient,
  connection: ProjectionConnection,
  input: unknown,
  options: { bootstrap?: boolean; actor?: Actor; contactId?: string } = {},
): Promise<{ linkId: string; appointmentId: string | null }> {
  const a = normalizeAttendance(input, connection.timezone);
  const org = connection.organizationId;
  const { data: before, error: readError } = await db
    .from("amigo_appointment_links")
    .select("id,appointment_id,remote_data,remote_status,effects_fingerprint")
    .eq("organization_id", org)
    .eq("connection_id", connection.id)
    .eq("attendance_id", a.remoteId)
    .maybeSingle();
  if (readError) throw new Error("Não foi possível conferir o vínculo da consulta.");
  const { data: link, error } = await db
    .from("amigo_appointment_links")
    .upsert(
      {
        organization_id: org,
        connection_id: connection.id,
        attendance_id: a.remoteId,
        patient_id: a.patientId,
      },
      { onConflict: "organization_id,connection_id,attendance_id" },
    )
    .select("id,appointment_id")
    .single();
  if (error || !link) throw new Error("Não foi possível guardar a consulta recebida do Amigo.");
  const { data: patient, error: patientError } = await db
    .from("amigo_patient_links")
    .select("contact_id,lead_id")
    .eq("organization_id", org)
    .eq("connection_id", connection.id)
    .eq("patient_id", a.patientId)
    .maybeSingle();
  if (patientError) throw new Error("Não foi possível conferir o destinatário da consulta.");
  const storeState = async (appointmentId: string | null, fingerprint?: string) => {
    const { error } = await db
      .from("amigo_appointment_links")
      .update({
        remote_status: a.remoteStatus,
        remote_data: a,
        synced_at: new Date().toISOString(),
        appointment_id: appointmentId,
        ...(fingerprint ? { effects_fingerprint: fingerprint } : {}),
      })
      .eq("organization_id", org)
      .eq("connection_id", connection.id)
      .eq("id", link.id);
    if (error) throw new Error("Estado local pendente de reconciliação.");
  };
  if (!patient) {
    await storeState(null);
    return { linkId: String(link.id), appointmentId: null };
  }
  if (options.contactId && patient.contact_id !== options.contactId)
    throw new Error("Paciente não vinculado a este contato.");

  const { data: type, error: typeError } = await db
    .from("calendar_event_types")
    .upsert(
      {
        organization_id: org,
        slug: `amigo-${connection.id.slice(0, 8)}-${a.eventId}`,
        name: a.title,
        duration_minutes: Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000),
        external_provider: "amigo",
        external_id: String(a.eventId),
        external_connection_id: connection.id,
      },
      { onConflict: "organization_id,slug" },
    )
    .select("id")
    .single();
  if (typeError || !type) throw new Error("Não foi possível vincular o tipo de atendimento.");
  const appointmentId = String(link.appointment_id ?? link.id);
  const unchanged = before?.appointment_id && hashDoCorpo(before.remote_data) === hashDoCorpo(a);
  if (!unchanged) {
    const { error: appointmentError } = await db.from("calendar_appointments").upsert(
      {
        id: appointmentId,
        organization_id: org,
        event_type_id: type.id,
        title: a.title,
        starts_at: a.startsAt,
        ends_at: a.endsAt,
        time_zone: connection.timezone,
        status: a.localStatus,
        authority: "amigo",
        external_status: a.remoteStatus,
        external_connection_id: connection.id,
        contact_id: patient.contact_id,
        owner_user_id: null,
        location_kind: "in_person",
        location_details: a.address,
        cancelled_at: a.localStatus === "cancelled" ? new Date().toISOString() : null,
        created_by_kind: "sync",
        source: "ui",
      },
      { onConflict: "id" },
    );
    if (appointmentError)
      throw new Error("Consulta confirmada no Amigo; projeção local pendente de reconciliação.");
  }
  await storeState(appointmentId);
  const { data: localRevision, error: revisionError } = await db
    .from("calendar_appointments")
    .select("revision")
    .eq("organization_id", org)
    .eq("id", appointmentId)
    .eq("authority", "amigo")
    .single();
  if (revisionError || !localRevision) throw new Error("Revisão local pendente de leitura.");
  const fingerprint = hashDoCorpo({
    revision: localRevision.revision,
    state: a,
    lead: patient.lead_id,
    contact: patient.contact_id,
  });
  if (options.bootstrap) await storeState(appointmentId, fingerprint);
  if (patient.lead_id) {
    const { error: leadLinkError } = await db.from("crm_lead_links").upsert(
      {
        organization_id: org,
        lead_id: patient.lead_id,
        target_kind: "appointment",
        target_id: appointmentId,
        link_kind: "scheduled",
      },
      { onConflict: "lead_id,target_kind,target_id,link_kind" },
    );
    if (leadLinkError) throw new Error("Vínculo com o negócio pendente de reconciliação.");
    if (!options.bootstrap && options.actor && before?.effects_fingerprint !== fingerprint) {
      const { moverLeadParaEtapaDeAgendamento } =
        await import("@/lib/leads/appointment-stage-move");
      const moved = await moverLeadParaEtapaDeAgendamento(db, {
        organizationId: org,
        leadId: String(patient.lead_id),
        transicao: a.localStatus,
      });
      if (["indisponivel", "falha_de_escrita"].includes(moved.motivo))
        throw new Error("Etapa do negócio pendente de atualização.");
      const { buildLeadActivityRow } = await import("@/lib/leads/activity-emitter");
      const digest = hashDoCorpo({ org, connection: connection.id, appointmentId, fingerprint });
      const activityId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const activity = buildLeadActivityRow({
        organizationId: org,
        leadId: String(patient.lead_id),
        contactId: String(patient.contact_id),
        type: !before
          ? "appointment_scheduled"
          : a.localStatus === "cancelled"
            ? "appointment_cancelled"
            : a.localStatus === "completed"
              ? "appointment_completed"
              : a.localStatus === "no_show"
                ? "appointment_no_show"
                : before?.remote_data?.startsAt !== a.startsAt
                  ? "appointment_rescheduled"
                  : "appointment_scheduled",
        sourceModule: "amigo",
        sourceId: appointmentId,
        actor: options.actor,
        reason: "Consulta atualizada pelo Amigo.",
        payload: { appointment_id: appointmentId, remote_status: a.remoteStatus },
      });
      const { error: activityError } = await db
        .from("crm_lead_activities")
        .upsert({ ...activity, id: activityId }, { onConflict: "id", ignoreDuplicates: true });
      if (activityError) throw new Error("Atividade da consulta pendente de registro.");
      await storeState(appointmentId, fingerprint);
    }
  }
  return { linkId: String(link.id), appointmentId };
}
