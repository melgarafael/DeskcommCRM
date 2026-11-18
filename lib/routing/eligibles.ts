/**
 * Carregador reutilizável de atendentes elegíveis (G5-02/G5-03 → G6-01/INB-12).
 *
 * A lógica de "quem pode receber uma conversa agora" (disponível ∧ dentro do
 * horário ∧ com folga) vivia inline no worker de roteamento. G6-01 unifica: o
 * mesmo cálculo alimenta o worker (cron), o handoff v2 (crm_request_human_handoff)
 * e o crm_get_queue_status — UM algoritmo, não três divergentes.
 *
 * O client é injetado (worker passa admin; tools MCP passam ctx.supabase admin),
 * mantendo a org-scoping explícita em toda query (service role bypassa RLS).
 */
import type { Json } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isAttendantEligible, isWithinSchedule, OPEN_LOAD_STATUSES } from "./eligibility";
import type { RoutingCandidate } from "./decide";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

export type RoutingScope =
  | { kind: "conversation_channel"; channelSessionId: string }
  /**
   * A FILA da conversa (migration 9062). `channelSessionId` opcional porque a
   * conversa pode não ter número (canal interno): quando tem, a política do
   * número continua valendo e o resultado é a INTERSEÇÃO — fila ∧ responsáveis
   * do número. Escopo novo, régua velha: nada aqui reimplementa carga, folga ou
   * horário do atendente.
   */
  | { kind: "sector"; sectorId: string; channelSessionId: string | null }
  | { kind: "organization_summary" };
export class InvalidRoutingChannel extends Error {
  constructor() { super("routing_channel_invalid"); }
}
export class InvalidRoutingSector extends Error {
  constructor() { super("routing_sector_invalid"); }
}

/**
 * A fila existe e está aberta agora? Janela vazia (`{}`) = 24/7 — janela existe
 * para RESTRINGIR, igual à jornada da pessoa. Quem chama usa o `open=false`
 * para ADIAR a entrega (o worker já reenfileira sem elegível), nunca para
 * descartar a conversa.
 */
export async function loadSectorWindow(
  supabase: SupabaseClient,
  organizationId: string,
  sectorId: string,
  now: Date,
): Promise<{ window: { schedule: unknown; open: boolean } }> {
  const { data: sector, error } = await supabase.from("attendant_sectors")
    .select("id, schedule").eq("organization_id", organizationId).eq("id", sectorId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!sector) throw new InvalidRoutingSector();
  const schedule = availabilityScheduleSchema.parse(
    (sector as { schedule?: unknown }).schedule ?? {},
  );
  return { window: { schedule, open: isWithinSchedule(schedule, now) } };
}


/** Elegíveis = disponíveis ∧ dentro do horário ∧ com folga (carga < capacidade). */
export async function loadEligibleAttendants(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date,
  scope: RoutingScope,
): Promise<RoutingCandidate[]> {
  let allowed: Set<string> | null = null;
  // A política do NÚMERO vale nos dois escopos que sabem qual é o número.
  const channelSessionId =
    scope.kind === "conversation_channel"
      ? scope.channelSessionId
      : scope.kind === "sector"
        ? scope.channelSessionId
        : null;
  if (channelSessionId) {
    const { data: channel, error: channelError } = await supabase.from("channel_sessions")
      .select("id").eq("organization_id", organizationId).eq("id", channelSessionId).maybeSingle();
    if (channelError) throw new Error(channelError.message);
    if (!channel) throw new InvalidRoutingChannel();
    const { data: policy, error: policyError } = await supabase.from("channel_routing_policies")
      .select("id").eq("organization_id", organizationId).eq("channel_session_id", channelSessionId).maybeSingle();
    if (policyError) throw new Error(policyError.message);
    if (policy) {
      const { data: responsibles, error } = await supabase.from("channel_routing_responsibles")
        .select("user_id").eq("organization_id", organizationId).eq("policy_id", policy.id);
      if (error) throw new Error(error.message);
      allowed = new Set((responsibles ?? []).map((r: { user_id: string }) => r.user_id));
      // Policy existente vazia é restrição explícita, não ausência de configuração.
      if (allowed.size === 0) return [];
    }
  }

  // (migration 9062) FILA: existe ∧ está aberta ∧ só quem é membro recebe.
  // A restrição do número, quando existe, continua valendo em cima: a fila é
  // interseção, não substituição — quem responde pelo setor mas não pelo número
  // não recebe por este caminho, e vice-versa.
  if (scope.kind === "sector") {
    const { data: sector, error: sectorError } = await supabase.from("attendant_sectors")
      .select("id, schedule").eq("organization_id", organizationId).eq("id", scope.sectorId).maybeSingle();
    if (sectorError) throw new Error(sectorError.message);
    if (!sector) throw new InvalidRoutingSector();
    const sectorSchedule = availabilityScheduleSchema.parse(
      (sector as { schedule?: unknown }).schedule ?? {},
    );
    // Fila fechada = ninguém elegível AGORA. O worker reenfileira (backoff),
    // então a conversa espera a abertura em vez de ser entregue fora do horário.
    if (!isWithinSchedule(sectorSchedule, now)) return [];
    const { data: links, error: linksError } = await supabase.from("attendant_sector_members")
      .select("user_id").eq("organization_id", organizationId).eq("sector_id", scope.sectorId);
    if (linksError) throw new Error(linksError.message);
    const members = new Set((links ?? []).map((r: { user_id: string }) => r.user_id));
    allowed = allowed === null
      ? members
      : new Set([...members].filter((id) => allowed!.has(id)));
    // Fila sem ninguém capaz de atender por este número: vazio, e isso é fato a
    // registrar — não silêncio (ver invariante da migration).
    if (allowed.size === 0) return [];
  }

  const { data: members, error: memberError } = await supabase.from("user_organizations")
    .select("user_id").eq("organization_id", organizationId).is("revoked_at", null)
    .in("role", ["agent", "manager", "admin"]);
  if (memberError) throw new Error(memberError.message);
  const active = new Set((members ?? []).map((r: { user_id: string }) => r.user_id));
  const { data: avail, error: availabilityError } = await supabase
    .from("attendant_availability").select("user_id, capacity, schedule")
    .eq("organization_id", organizationId).eq("is_available", true);
  if (availabilityError) throw new Error(availabilityError.message);
  const rows = ((avail ?? []) as Array<{ user_id: string; capacity: number; schedule: unknown }>)
    .filter((r) => active.has(r.user_id) && (allowed === null || allowed.has(r.user_id)));
  if (rows.length === 0) return [];

  const userIds = rows.map((r) => r.user_id);

  // Carga atual: conversas abertas atribuídas, contadas por dono (1 query).
  const { data: openConvs, error: loadError } = await supabase
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", organizationId)
    .in("assigned_to_user_id", userIds)
    .in("status", OPEN_LOAD_STATUSES as unknown as string[]);
  if (loadError) throw new Error(loadError.message);
  const loadByUser = new Map<string, number>();
  for (const c of (openConvs ?? []) as Array<{ assigned_to_user_id: string | null }>) {
    if (c.assigned_to_user_id) {
      loadByUser.set(c.assigned_to_user_id, (loadByUser.get(c.assigned_to_user_id) ?? 0) + 1);
    }
  }

  // Última atribuição recebida (rodízio real, sem coluna de estado).
  let history = supabase
    .from("conversation_assignment_events")
    .select("to_user_id, created_at, conversations!inner(organization_id, channel_session_id)")
    .eq("organization_id", organizationId)
    .in("to_user_id", userIds)
    .order("created_at", { ascending: false });
  if (scope.kind === "conversation_channel") {
    history = history.eq("conversations.organization_id", organizationId)
      .eq("conversations.channel_session_id", scope.channelSessionId);
  } else if (scope.kind === "sector") {
    // Rodízio da FILA: "quem recebeu há mais tempo" dentro da própria fila — sem
    // isso, uma pessoa que acabou de receber 5 conversas pelo outro setor
    // apareceria como a mais antiga desta fila e levaria a próxima.
    history = history.eq("conversations.organization_id", organizationId)
      .eq("conversations.sector_id", scope.sectorId);
  }
  const { data: assignEvents, error: historyError } = await history;
  if (historyError) throw new Error(historyError.message);
  const lastAssignedByUser = new Map<string, number>();
  for (const e of (assignEvents ?? []) as Array<{ to_user_id: string | null; created_at: string }>) {
    if (e.to_user_id && !lastAssignedByUser.has(e.to_user_id)) {
      lastAssignedByUser.set(e.to_user_id, new Date(e.created_at).getTime());
    }
  }

  const candidates: RoutingCandidate[] = [];
  for (const r of rows) {
    const currentLoad = loadByUser.get(r.user_id) ?? 0;
    const schedule = availabilityScheduleSchema.parse(r.schedule ?? {});
    const eligible = isAttendantEligible(
      { isAvailable: true, capacity: r.capacity, currentLoad, schedule },
      now,
    );
    if (eligible) {
      candidates.push({
        userId: r.user_id,
        currentLoad,
        scheduleSnapshot: r.schedule as Json,
        lastAssignedAt: lastAssignedByUser.get(r.user_id) ?? null,
      });
    }
  }
  return candidates;
}
