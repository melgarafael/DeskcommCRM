import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOCAIS_DE_AGENDAMENTO } from "@/lib/agenda/tipos";
import { rotuloDoLocal } from "@/lib/agenda/locais";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { instanteDoBanco } from "@/lib/tempo/agora";

/** Mutações que tornam qualquer comprovante anterior do turno insuficiente. */
export const ESCRITAS_DE_AGENDAMENTO: ReadonlySet<string> = new Set([
  "crm_book_appointment",
  "crm_find_and_book_appointment",
  "crm_reschedule_appointment",
  "crm_cancel_appointment",
  "crm_confirm_appointment",
  "crm_set_appointment_outcome",
]);

/** Hora ilegível não comprova: `null` nunca coincide nem ordena. */
function mesmoInstante(a: unknown, b: unknown): boolean {
  const instante = instanteDoBanco(a);
  return instante !== null && instante === instanteDoBanco(b);
}

function terminaDepois(inicio: unknown, fim: unknown): boolean {
  const de = instanteDoBanco(inicio);
  const ate = instanteDoBanco(fim);
  return de !== null && ate !== null && ate > de; // ISO em UTC ordena como texto
}

const reciboSchema = z
  .object({
    id: z.uuid(),
    status: z.literal("confirmed"),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    revision: z.number().int().positive(),
  })
  .refine((r) => terminaDepois(r.starts_at, r.ends_at));

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

type LinhaDeAgendamento = z.infer<typeof linhaSchema>;

export interface EvidenciaDeAgendamento extends ReciboDeAgendamento {
  organization_id: string;
  contact_id: string;
  event_type_id: string;
  tipo: string;
  local: string;
  time_zone: string;
  beneficiario: string | null;
}

interface EscopoDoContato {
  organizationId: string;
  contactId: string | null;
}

/** A linha é desta organização e deste contato, e nenhuma aprovação humana está pendente. */
function comprovaReserva(row: LinhaDeAgendamento, escopo: EscopoDoContato): boolean {
  return (
    row.organization_id === escopo.organizationId &&
    row.contact_id === escopo.contactId &&
    row.calendar_event_types.organization_id === escopo.organizationId &&
    row.calendar_event_types.id === row.event_type_id &&
    !(
      row.service_requires_confirmation === true &&
      (!row.service_confirmed_by_user_id || !row.service_confirmed_at)
    )
  );
}

/** Projeção explícita: não transporta notas, nome do contato responsável, link ou estado Google. */
function projetarEvidencia(row: LinhaDeAgendamento): EvidenciaDeAgendamento {
  return {
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
  };
}

/**
 * Confere o recibo atual antes da revisão (inclusive replay de idempotência).
 * A leitura usa service role: filtra organização/contato E o tipo relacionado.
 * Mudança de estado, horário ou revisão descarta o recibo inteiro; nunca regrava.
 */
export async function conferirRecibosDeAgendamento(
  db: SupabaseClient,
  escopo: EscopoDoContato,
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
      !comprovaReserva(row, escopo) ||
      row.revision !== recibo.revision ||
      !mesmoInstante(row.starts_at, recibo.starts_at) ||
      !mesmoInstante(row.ends_at, recibo.ends_at)
    )
      return [];
    evidencias.push(projetarEvidencia(row));
  }
  return evidencias;
}

/** Teto da lista que vai ao revisor. É o mesmo do recibo de grupo. */
export const MAXIMO_DE_RESERVAS_NA_REVISAO = 20;

export interface AgendaDaRevisao {
  evidencias: EvidenciaDeAgendamento[];
  /** Há reservas além do teto. Avisa o revisor; não comprova nenhuma delas. */
  parcial: boolean;
}

/**
 * Reserva feita em turno anterior não deixa recibo neste turno. Com evidência
 * comercial na revisão, a confirmação fiel dela era vetada (21 de 24 no #3205).
 *
 * O motor lê pelo `pool`, que ignora RLS: os filtros de organização e contato
 * deste SQL são a guarda, e `comprovaReserva` os confere de novo em cada linha.
 * Revisão e datas saem como JSON: o driver devolveria bigint como texto e
 * timestamptz como Date, e `linhaSchema` descartaria toda linha em silêncio.
 */
export async function lerReservasConfirmadasDoContato(
  db: Queryable,
  escopo: EscopoDoContato,
  agora: Date,
): Promise<AgendaDaRevisao> {
  if (!escopo.contactId) return { evidencias: [], parcial: false };
  const { rows } = await db.query(
    `select a.id, a.organization_id, a.contact_id, a.event_type_id, a.status,
            a.time_zone, a.location_kind, a.location_details, a.participant_name,
            a.service_requires_confirmation, a.service_confirmed_by_user_id,
            to_json(a.revision) as revision,
            to_json(a.service_confirmed_at) as service_confirmed_at,
            to_json(a.starts_at) as starts_at,
            to_json(a.ends_at) as ends_at,
            json_build_object('id', t.id, 'organization_id', t.organization_id, 'name', t.name)
              as calendar_event_types
       from calendar_appointments a
       join calendar_event_types t
         on t.id = a.event_type_id and t.organization_id = a.organization_id
      where a.organization_id = $1
        and a.contact_id = $2
        and a.service_block = false
        and a.status = 'confirmed'
        and a.ends_at >= $3
      order by a.starts_at
      limit $4`,
    [escopo.organizationId, escopo.contactId, agora.toISOString(), MAXIMO_DE_RESERVAS_NA_REVISAO + 1],
  );
  const evidencias = rows.slice(0, MAXIMO_DE_RESERVAS_NA_REVISAO).flatMap((bruta) => {
    const linha = linhaSchema.safeParse(bruta);
    return linha.success && comprovaReserva(linha.data, escopo) ? [projetarEvidencia(linha.data)] : [];
  });
  return { evidencias, parcial: rows.length > MAXIMO_DE_RESERVAS_NA_REVISAO };
}

/**
 * Uma fonte por revisão, nunca as duas.
 *
 * O turno que tocou na agenda fica só com o recibo: a mutação começa antes de
 * aparecer no banco, e uma leitura em voo comprovaria a reserva que está sendo
 * cancelada. Sem evidência comercial o prompt padrão não veta a confirmação
 * (0 de 6 no #3205), e levar a agenda trocaria o prompt de toda conversa de quem
 * tem reserva.
 */
export async function lerAgendaDaRevisao(
  admin: SupabaseClient,
  db: Queryable,
  escopo: EscopoDoContato,
  turno: {
    recibos: readonly ReciboDeAgendamento[];
    geracaoDaAgenda: number;
    temEvidenciaComercial: boolean;
    agora: Date;
  },
): Promise<AgendaDaRevisao> {
  if (turno.geracaoDaAgenda === 0 && turno.temEvidenciaComercial) {
    return lerReservasConfirmadasDoContato(db, escopo, turno.agora);
  }
  return {
    evidencias: await conferirRecibosDeAgendamento(admin, escopo, turno.recibos),
    parcial: false,
  };
}
