import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { googleRpc } from "../google/sync-store";
import { syncCalendar } from "../google/calendar-executor";
import { candidatosDoServico, horarioDoServicoSchema, MODOS_DE_RESERVA, type CandidatoDoServico } from "./regras";

const dadosDoServicoSchema = z.object({
  event_type_id: z.uuid(), name: z.string(), slug: z.string(), is_active: z.boolean(), service_enabled: z.boolean(),
  booking_mode: z.enum(MODOS_DE_RESERVA), service_capacity: z.number().int().nullable(), service_timezone: z.string(),
  duration_minutes: z.number().int().positive(), slot_interval_minutes: z.number().int().positive().nullable(),
  service_revision: z.number().int().positive(), requires_confirmation: z.boolean(), destination_calendar_id: z.uuid().nullable(),
  service_publication_mode: z.enum(["none", "service", "professional"]),
  schedule: z.array(horarioDoServicoSchema), professionals: z.array(z.uuid()),
  resources: z.array(z.object({ resource_id: z.uuid(), units: z.number().int().positive() })), calendar_sources: z.array(z.uuid()),
});
export type DadosDoServico = z.infer<typeof dadosDoServicoSchema>;
export const disponibilidadeDoServicoSchema = z.object({
  available: z.boolean(), reason: z.string().nullable(), starts_at: z.string(), ends_at: z.string().optional(),
  duration_minutes: z.number().optional(), owner_user_id: z.uuid().nullable().optional(),
  booking_mode: z.enum(MODOS_DE_RESERVA).optional(), capacity_rule: z.string().optional(),
  capacity_limit: z.number().nullable().optional(), occupied: z.number().optional(), remaining_capacity: z.number().nullable().optional(),
  available_professionals: z.number().optional(), service_revision: z.number().optional(), coverage_verified: z.boolean().optional(),
  destination_calendar_id: z.uuid().nullable().optional(), requires_confirmation: z.boolean().optional(), time_zone: z.string().optional(),
});
export type DisponibilidadeDoServico = z.infer<typeof disponibilidadeDoServicoSchema>;

/** Mesmo client do chamador. A sessão usa RPC redigida, sem admin escondido na coleta. */
export async function lerServico(db: SupabaseClient, organizationId: string, eventTypeId: string): Promise<DadosDoServico | null> {
  const raw = await googleRpc(db, "fn_calendar_service_read", { p_org: organizationId, p_type: eventTypeId });
  return raw == null ? null : dadosDoServicoSchema.parse(raw);
}

/** Só o caminho servidor explicitamente autorizado passa o client de escrita para atualizar fontes. */
export async function atualizarFontesDoServico(
  admin: SupabaseClient, organizationId: string, eventTypeId: string, ownerUserId?: string | null,
): Promise<{ complete: boolean; calendars: number }> {
  const fontes = z.array(z.object({ id: z.uuid() })).parse(await googleRpc(admin, "fn_calendar_service_sources_to_refresh", {
    p_org: organizationId, p_type: eventTypeId, p_owner: ownerUserId ?? null,
  }));
  let complete = true;
  // Respeitar o lease/cursor nativo; busy ou partial não viram cobertura completa.
  for (const fonte of fontes) {
    const state = await syncCalendar(admin, organizationId, fonte.id);
    if (state !== "complete") complete = false;
  }
  return { complete, calendars: fontes.length };
}

export async function consultarServico(
  db: SupabaseClient, organizationId: string, service: DadosDoServico,
  params: { de: Date; ate: Date; agora: Date; ownerUserId?: string | null },
): Promise<{ candidates: CandidatoDoServico[]; availability: DisponibilidadeDoServico[] }> {
  const candidates = candidatosDoServico(service, service.schedule, params.de, params.ate);
  const raw = await googleRpc(db, "fn_calendar_service_preview", {
    p_org: organizationId, p_type: service.event_type_id, p_starts: candidates.map((c) => c.starts_at),
    p_owner: params.ownerUserId ?? null, p_now: params.agora.toISOString(),
  });
  return { candidates, availability: z.array(disponibilidadeDoServicoSchema).parse(raw) };
}

export { MOTIVOS_DO_SERVICO } from "./motivos";
