import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOCAIS_DE_AGENDAMENTO } from "@/lib/agenda/tipos";
import { rotuloDoLocal } from "@/lib/agenda/locais";

/** Mutações que tornam qualquer comprovante anterior do turno insuficiente. */
export const ESCRITAS_DE_AGENDAMENTO: ReadonlySet<string> = new Set([
  "crm_book_appointment",
  "crm_find_and_book_appointment",
  "crm_reschedule_appointment",
  "crm_cancel_appointment",
  "crm_confirm_appointment",
  "crm_set_appointment_outcome",
]);

const reciboSchema = z
  .object({
    id: z.uuid(),
    status: z.literal("confirmed"),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    revision: z.number().int().positive(),
  })
  .refine((r) => Date.parse(r.ends_at) > Date.parse(r.starts_at));

export type ReciboDeAgendamento = z.infer<typeof reciboSchema>;

/** Só o RESULTADO estruturado de uma mutação bem-sucedida; nunca argumentos ou prosa. */
export function extrairRecibosDeAgendamento(resultado: unknown): ReciboDeAgendamento[] {
  const r = z
    .object({
      marcado: z.boolean().optional(),
      remarcado: z.boolean().optional(),
      confirmado: z.boolean().optional(),
      aguarda_confirmacao: z.boolean().optional(),
      agenda_externa_nunca_lida: z.boolean().optional(),
      resultado_incerto: z.boolean().optional(),
      error: z.unknown().optional(),
      compromisso: z.unknown(),
    })
    .safeParse(resultado);
  if (
    !r.success ||
    r.data.error !== undefined ||
    r.data.resultado_incerto ||
    r.data.aguarda_confirmacao ||
    r.data.agenda_externa_nunca_lida ||
    !(r.data.marcado === true || r.data.remarcado === true || r.data.confirmado === true)
  )
    return [];
  const compromisso = r.data.compromisso as Record<string, unknown> | null;
  if (
    !compromisso ||
    (compromisso.human_confirmation !== undefined &&
      !["not_required", "confirmed"].includes(String(compromisso.human_confirmation)))
  )
    return [];
  // Reserva de grupo só vale inteira, e o teto coincide com o input da agenda.
  const bruto = Array.isArray(compromisso.appointments) ? compromisso.appointments : [compromisso];
  const recibos = z.array(reciboSchema).min(1).max(20).safeParse(bruto);
  return recibos.success ? recibos.data : [];
}

const linhaSchema = reciboSchema.and(
  z.object({
    organization_id: z.uuid(),
    contact_id: z.uuid(),
    event_type_id: z.uuid(),
    time_zone: z.string().min(1),
    location_kind: z.enum(LOCAIS_DE_AGENDAMENTO),
    location_details: z.string().nullable(),
    participant_name: z.string().trim().min(1).max(120).nullable(),
    service_requires_confirmation: z.boolean().nullable(),
    service_confirmed_by_user_id: z.uuid().nullable(),
    service_confirmed_at: z.string().nullable(),
    calendar_event_types: z.object({
      id: z.uuid(),
      organization_id: z.uuid(),
      name: z.string().min(1).max(200),
    }),
  }),
);

export interface EvidenciaDeAgendamento extends ReciboDeAgendamento {
  organization_id: string;
  contact_id: string;
  event_type_id: string;
  tipo: string;
  local: string;
  time_zone: string;
  beneficiario: string | null;
}

/**
 * Confere o recibo atual antes da revisão (inclusive replay de idempotência).
 * A leitura usa service role: filtra organização/contato E o tipo relacionado.
 * Mudança de estado, horário ou revisão descarta o recibo inteiro; nunca regrava.
 */
export async function conferirRecibosDeAgendamento(
  db: SupabaseClient,
  escopo: { organizationId: string; contactId: string | null },
  recibos: readonly ReciboDeAgendamento[],
): Promise<EvidenciaDeAgendamento[]> {
  if (!escopo.contactId || recibos.length === 0) return [];
  const { data, error } = await db
    .from("calendar_appointments")
    .select(
      "id, organization_id, contact_id, event_type_id, status, starts_at, ends_at, revision, time_zone, location_kind, location_details, participant_name, service_requires_confirmation, service_confirmed_by_user_id, service_confirmed_at, calendar_event_types!calendar_appointments_event_type_id_fkey!inner(id, organization_id, name)",
    )
    .eq("organization_id", escopo.organizationId)
    .eq("contact_id", escopo.contactId)
    .eq("calendar_event_types.organization_id", escopo.organizationId)
    .eq("service_block", false)
    .in(
      "id",
      recibos.map((r) => r.id),
    );
  if (error) throw new Error("booking_evidence_lookup_failed");
  if (!data || data.length !== recibos.length) return [];
  const evidencias: EvidenciaDeAgendamento[] = [];
  for (const recibo of recibos) {
    const parsed = linhaSchema.safeParse(data.find((r) => r.id === recibo.id));
    if (!parsed.success) return [];
    const row = parsed.data;
    if (
      row.organization_id !== escopo.organizationId ||
      row.contact_id !== escopo.contactId ||
      row.calendar_event_types.organization_id !== escopo.organizationId ||
      row.calendar_event_types.id !== row.event_type_id ||
      row.revision !== recibo.revision ||
      Date.parse(row.starts_at) !== Date.parse(recibo.starts_at) ||
      Date.parse(row.ends_at) !== Date.parse(recibo.ends_at) ||
      (row.service_requires_confirmation === true &&
        (!row.service_confirmed_by_user_id || !row.service_confirmed_at))
    )
      return [];
    // Projeção explícita: não transporta notas, nome do contato responsável, link ou estado Google.
    evidencias.push({
      id: row.id,
      status: row.status,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      revision: row.revision,
      organization_id: row.organization_id,
      contact_id: row.contact_id,
      event_type_id: row.event_type_id,
      tipo: row.calendar_event_types.name,
      local: rotuloDoLocal(row.location_kind, row.location_details)!,
      time_zone: row.time_zone,
      beneficiario: row.participant_name,
    });
  }
  return evidencias;
}
