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
  /** `kind='space'` é lugar reservável (capacidade em pessoas); `resource` é exigência com unidades. */
  resources: z.array(z.object({
    resource_id: z.uuid(), units: z.number().int().positive(),
    kind: z.enum(["resource", "space"]).default("resource"),
    name: z.string().optional(), capacity: z.number().int().positive().optional(), sector: z.string().nullable().optional(),
  })), calendar_sources: z.array(z.uuid()),
});
export type DadosDoServico = z.infer<typeof dadosDoServicoSchema>;
export const disponibilidadeDoServicoSchema = z.object({
  available: z.boolean(), reason: z.string().nullable(), starts_at: z.string(), ends_at: z.string().optional(),
  duration_minutes: z.number().optional(), owner_user_id: z.uuid().nullable().optional(),
  booking_mode: z.enum(MODOS_DE_RESERVA).optional(), capacity_rule: z.string().optional(),
  capacity_limit: z.number().nullable().optional(), occupied: z.number().optional(), remaining_capacity: z.number().nullable().optional(),
  available_professionals: z.number().optional(), service_revision: z.number().optional(), coverage_verified: z.boolean().optional(),
  destination_calendar_id: z.uuid().nullable().optional(), requires_confirmation: z.boolean().optional(), time_zone: z.string().optional(),
  /** O lugar escolhido e a ocupação dele, em pessoas, no período consultado (issue #4029). */
  space_id: z.uuid().nullable().optional(), space_name: z.string().nullable().optional(), space_sector: z.string().nullable().optional(),
  space_capacity: z.number().nullable().optional(), space_occupied: z.number().optional(),
  space_remaining_capacity: z.number().nullable().optional(), party_size: z.number().optional(),
  /** Lugares do serviço que estão livres neste horário (um por lugar da prévia). */
  free_spaces: z.array(z.object({ id: z.uuid(), name: z.string(), sector: z.string().nullable() })).optional(),
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

/** Os `resources` do serviço com `kind === 'space'`, ordenados por nome (pt-BR). */
export function lugaresDoServico(service: DadosDoServico): Array<{ id: string; name: string; sector: string | null }> {
  return service.resources
    .filter((r) => r.kind === "space")
    .map((r) => ({ id: r.resource_id, name: r.name ?? "", sector: r.sector ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** Uma chamada de prévia POR lugar. Quando o serviço tem lugar e nenhum foi pedido,
 * consulta cada um e junta as respostas; quando já foi pedido, uma chamada só com p_space.
 */
export async function consultarServico(
  db: SupabaseClient, organizationId: string, service: DadosDoServico,
  params: { de: Date; ate: Date; agora: Date; ownerUserId?: string | null; spaceId?: string | null; partySize?: number | null },
): Promise<{ candidates: CandidatoDoServico[]; availability: DisponibilidadeDoServico[] }> {
  const candidates = candidatosDoServico(service, service.schedule, params.de, params.ate);
  const lugares = lugaresDoServico(service);

  if (params.spaceId) {
    // Com lugar pedido, uma chamada só com p_space (o comportamento de hoje).
    const raw = await googleRpc(db, "fn_calendar_service_preview", {
      p_org: organizationId, p_type: service.event_type_id, p_starts: candidates.map((c) => c.starts_at),
      p_owner: params.ownerUserId ?? null, p_now: params.agora.toISOString(),
      p_space: params.spaceId,
      ...(params.partySize ? { p_party: params.partySize } : {}),
    });
    return { candidates, availability: z.array(disponibilidadeDoServicoSchema).parse(raw) };
  }

  // Sem lugar pedido e o serviço tem lugar: uma chamada por lugar, em paralelo.
  // As prévias voltam na mesma ordem de `p_starts` (isto é, a ordem de candidates).
  if (lugares.length > 0) {
    const porLugar: unknown[][] = await Promise.all(lugares.map(async (lugar) =>
      z.array(z.unknown()).parse(await googleRpc(db, "fn_calendar_service_preview", {
        p_org: organizationId, p_type: service.event_type_id, p_starts: candidates.map((c) => c.starts_at),
        p_owner: params.ownerUserId ?? null, p_now: params.agora.toISOString(),
        p_space: lugar.id,
        ...(params.partySize ? { p_party: params.partySize } : {}),
      })),
    ));
    const availability = juncaoPreviasPorLugar(candidates, porLugar, lugares);
    return { candidates, availability: z.array(disponibilidadeDoServicoSchema).parse(availability) };
  }

  // Sem lugar: uma chamada só, sem p_space (igual a hoje).
  const raw = await googleRpc(db, "fn_calendar_service_preview", {
    p_org: organizationId, p_type: service.event_type_id, p_starts: candidates.map((c) => c.starts_at),
    p_owner: params.ownerUserId ?? null, p_now: params.agora.toISOString(),
    ...(params.partySize ? { p_party: params.partySize } : {}),
  });
  return { candidates, availability: z.array(disponibilidadeDoServicoSchema).parse(raw) };
}

/** Junta as prévias de vários lugares numa linha por horário (índice por posição).
 * Para cada índice i de candidates, olha a linha i de cada lugar. Se algum lugar
 * está livre: linha do PRIMEIRO livre + free_spaces com todos os livres. Se
 * nenhum: linha do PRIMEIRO lugar, free_spaces: [], e reason = space_capacity_reached
 * se todos deram esse motivo, senão o do primeiro. */
function juncaoPreviasPorLugar(
  candidates: CandidatoDoServico[], porLugar: unknown[][], lugares: Array<{ id: string; name: string; sector: string | null }>,
): DisponibilidadeDoServico[] {
  return candidates.map((c, i) => {
    const linhas = lugares.map((_lugar, idx) => porLugar[idx]?.[i] as DisponibilidadeDoServico | undefined);
    const linhaPrimeiro = linhas[0] ?? { available: false, reason: null, starts_at: c.starts_at, ends_at: c.ends_at };

    const livros = lugares.filter((_lugar, idx) => linhas[idx]?.available === true);
    if (livros.length > 0) {
      const iLivre = linhas.findIndex((l) => l?.available === true);
      const linhaLivre = linhas[iLivre] ?? linhaPrimeiro;
      const livre = lugares[iLivre];
      return {
        ...linhaLivre,
        free_spaces: livros.map((l) => ({ id: l.id, name: l.name, sector: l.sector })),
      };
    }
    const todosCapacidade = linhas.every((l) => l?.reason === "space_capacity_reached");
    return {
      ...linhaPrimeiro,
      free_spaces: [],
      reason: todosCapacidade ? "space_capacity_reached" : linhaPrimeiro.reason,
    };
  });
}

/** Para UM horário, uma prévia por lugar (em paralelo) e devolve o primeiro lugar
 * livre (ordem de lugaresDoServico) cuja linha 0 vem available, com `motivo: null`.
 * Se nenhum está livre, `livre: null` e o motivo pela regra de juncaoPreviasPorLugar:
 * space_capacity_reached só se TODOS deram esse motivo, senão o do primeiro lugar
 * (fora da programação, bloqueio etc. não podem virar "lugar ocupado").
 * Serviço sem lugar: `{ livre: null, motivo: null }`. Mesmo p_owner. */
export async function primeiroLugarLivre(
  db: SupabaseClient, organizationId: string, service: DadosDoServico,
  startsAt: string, ownerUserId?: string | null, partySize?: number | null,
): Promise<{ livre: { id: string; name: string } | null; motivo: string | null }> {
  const lugares = lugaresDoServico(service);
  if (lugares.length === 0) return { livre: null, motivo: null };
  const agora = new Date();
  const porLugar: unknown[][] = await Promise.all(lugares.map(async (lugar) =>
    z.array(z.unknown()).parse(await googleRpc(db, "fn_calendar_service_preview", {
      p_org: organizationId, p_type: service.event_type_id, p_starts: [startsAt],
      p_owner: ownerUserId ?? null, p_now: agora.toISOString(),
      p_space: lugar.id,
      ...(partySize ? { p_party: partySize } : {}),
    })),
  ));
  const linhas = lugares.map((_lugar, i) => (porLugar[i] ?? [])[0] as DisponibilidadeDoServico | undefined);
  for (let i = 0; i < lugares.length; i += 1) {
    const lugar = lugares[i];
    if (linhas[i]?.available === true && lugar) return { livre: { id: lugar.id, name: lugar.name }, motivo: null };
  }
  const todosCapacidade = linhas.every((l) => l?.reason === "space_capacity_reached");
  return { livre: null, motivo: todosCapacidade ? "space_capacity_reached" : (linhas[0]?.reason ?? null) };
}

export { MOTIVOS_DO_SERVICO } from "./motivos";
