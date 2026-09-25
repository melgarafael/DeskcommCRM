/**
 * Gatilho CLIENTE VOLTOU (`trigger_config.kind='inbound_after_silence'`).
 *
 * EVENT-DRIVEN, irmão de `gatilho-etapa.ts`: o fato É um evento
 * (`message.received`). O que o diferencia do silêncio é o instante — aqui o
 * cliente ACABOU de escrever, depois de X sem falar.
 *
 * ⚠️ UMA VOZ SÓ. O drain do agente (`ai_agent.dispatch_requested`) também
 * acorda neste inbound. Sem o skip em `ceder-turno-ao-retorno.ts`, o cliente
 * recebe a mensagem deste fluxo E a resposta do agente. O predicado
 * (`gapQualificaRetorno`) é o mesmo nos dois lados.
 *
 * ⚠️ O BURACO NÃO É `conversations.last_inbound_at`. Quando o handler roda, o
 * carimbo já é "agora". A inbound ANTERIOR vive em `messages`, excluindo a
 * mensagem corrente. DIRC: referenciar, não duplicar.
 *
 * Regras que este produtor respeita:
 *   - um follow-up vivo por contato (`23505` → skip);
 *   - gate do agente só quando o grafo pede IA (`decidirAgenteDoEnrollmentAutomatico`);
 *   - conversa com humano no comando não dispara;
 *   - primeiro inbound da vida não é retorno;
 *   - trigger Postgres nunca faz HTTP.
 */
import { serviceForEvent } from "@/lib/atendimento/origem";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import {
  decidirAgenteDoEnrollmentAutomatico,
  noDeGatilhoDoGrafo,
  type FollowupGateDb,
  type NoDeGatilho,
} from "./agent-followup-gate";
import { gapQualificaRetorno, segmentoCasa } from "./gap-de-retorno";

export const EVENTO_DE_RETORNO = "message.received";

export interface PointerDeRetorno {
  id: string;
  organization_id: string;
  active_version_id: string;
  threshold_minutes: number;
  segments: string[];
}

export interface EstadoDaConversaDeRetorno {
  is_group: boolean;
  is_blocked: boolean;
  force_human: boolean;
  assignee_kind: string | null;
  bot_silenced_until: string | null;
  tags: string[];
}

export interface EnrollmentVivoRef {
  pointer_id: string;
}

export interface GatilhoRetornoDb {
  carregaPointersDeRetorno(orgId: string): Promise<PointerDeRetorno[]>;
  carregaInboundAnterior(orgId: string, contactId: string, messageId: string): Promise<Date | null>;
  carregaEstadoDaConversa(
    orgId: string,
    conversationId: string,
    contactId: string,
  ): Promise<EstadoDaConversaDeRetorno | null>;
  carregaEnrollmentVivo(orgId: string, contactId: string): Promise<EnrollmentVivoRef | null>;
  carregaNoDeGatilho(orgId: string, versionId: string): Promise<NoDeGatilho | null>;
  insereEnrollment(input: {
    service_origin?: unknown;
    event_id?: string;
    organization_id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    conversation_id: string;
    current_node_id: string;
    /**
     * `next_eval_at` OMITIDO de propósito: o `default now()` da 0147 decide. O
     * "agora" do processo ainda é FUTURO para o claim (now() do Postgres).
     */
    next_eval_at?: string;
    agent_id: string | null;
  }): Promise<{ inserted: boolean; id: string | null; reason?: "stale_origin" }>;
  insereEventoDoEnrollment(evento: {
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<void>;
}

export interface GatilhoRetornoSummary {
  matched: boolean;
  pointers_armados: number;
  pointers_barrados_pelo_gate: number;
  enrolled: number;
  skipped_existing: number;
  skipped_stale_origin?: number;
  skipped_gap: number;
  skipped_humano: number;
  skipped_grupo: number;
  skipped_bloqueado: number;
  /** Preenchido quando enrollou — o handler avança o fluxo neste request. */
  contact_id: string | null;
}

export interface GatilhoRetornoDeps {
  db: GatilhoRetornoDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function vazio(): GatilhoRetornoSummary {
  return {
    matched: false,
    pointers_armados: 0,
    pointers_barrados_pelo_gate: 0,
    enrolled: 0,
    skipped_existing: 0,
    skipped_gap: 0,
    skipped_humano: 0,
    skipped_grupo: 0,
    skipped_bloqueado: 0,
    contact_id: null,
  };
}

export function humanoNoComando(estado: EstadoDaConversaDeRetorno, agora: Date): boolean {
  if (estado.force_human) return true;
  if (estado.assignee_kind === "user") return true;
  const ate = estado.bot_silenced_until;
  if (!ate) return false;
  if (ate === "infinity") return true;
  const fim = Date.parse(ate);
  return !Number.isNaN(fim) && fim > agora.getTime();
}

/**
 * Aplica UMA linha de `message.received`. Testável contra fake de DB; o adapter
 * de produção está no fim deste arquivo.
 */
export async function aplicaGatilhoDeRetorno(
  deps: GatilhoRetornoDeps,
  row: EventRow,
): Promise<GatilhoRetornoSummary> {
  const summary = vazio();
  if (row.event_type !== EVENTO_DE_RETORNO) return summary;

  const contatoId = textoOuNulo(row.payload.contact_id);
  const conversaId = textoOuNulo(row.payload.conversation_id);
  const mensagemId = textoOuNulo(row.payload.message_id) ?? textoOuNulo(row.entity_id);
  if (!contatoId || !conversaId || !mensagemId) return summary;
  summary.matched = true;
  summary.contact_id = contatoId;

  const armados = await deps.db.carregaPointersDeRetorno(row.organization_id);
  summary.pointers_armados = armados.length;
  if (armados.length === 0) return summary;

  const estado = await deps.db.carregaEstadoDaConversa(row.organization_id, conversaId, contatoId);
  if (!estado) return summary;
  if (estado.is_group) {
    summary.skipped_grupo = armados.length;
    return summary;
  }
  if (estado.is_blocked) {
    summary.skipped_bloqueado = armados.length;
    return summary;
  }
  if (humanoNoComando(estado, deps.clock())) {
    summary.skipped_humano = armados.length;
    return summary;
  }

  const anterior = await deps.db.carregaInboundAnterior(row.organization_id, contatoId, mensagemId);
  const agora = deps.clock();

  const vivos = await deps.db.carregaEnrollmentVivo(row.organization_id, contatoId);

  for (const pointer of armados) {
    if (!gapQualificaRetorno(anterior, agora, pointer.threshold_minutes)) {
      summary.skipped_gap++;
      continue;
    }
    if (!segmentoCasa(pointer.segments, estado.tags)) continue;

    if (vivos && vivos.pointer_id !== pointer.id) {
      // Outro fluxo já ocupa o único slot vivo deste contato. Insert daria
      // 23505; contar aqui evita ir ao banco para perder.
      summary.skipped_existing++;
      continue;
    }

    const noDeGatilho = await deps.db.carregaNoDeGatilho(row.organization_id, pointer.active_version_id);
    if (!noDeGatilho) continue;
    const { agentId, barrado } = await decidirAgenteDoEnrollmentAutomatico(
      deps.gateDb,
      row.organization_id,
      pointer.id,
      noDeGatilho.pedeAgente,
    );
    if (barrado) {
      summary.pointers_barrados_pelo_gate++;
      continue;
    }

    const { inserted, id, reason } = await deps.db.insereEnrollment({
      service_origin: row.payload.service_origin,
      event_id: row.id,
      organization_id: row.organization_id,
      pointer_id: pointer.id,
      version_id: pointer.active_version_id,
      contact_id: contatoId,
      conversation_id: conversaId,
      current_node_id: noDeGatilho.id,
      agent_id: agentId,
    });
    if (!inserted) {
      if (reason === "stale_origin") summary.skipped_stale_origin = (summary.skipped_stale_origin ?? 0) + 1;
      else summary.skipped_existing++;
      continue;
    }
    summary.enrolled++;

    if (id) {
      await deps.db.insereEventoDoEnrollment({
        organization_id: row.organization_id,
        enrollment_id: id,
        node_id: noDeGatilho.id,
        event_type: "enrolled_by_inbound_after_silence",
        payload: {
          conversation_id: conversaId,
          message_id: mensagemId,
          event_log_id: row.id,
          threshold_minutes: pointer.threshold_minutes,
          previous_inbound_at: anterior?.toISOString() ?? null,
        },
        idempotency_key: `gatilho-retorno:${row.id}`,
      });
    }
  }

  return summary;
}

export function createSupabaseGatilhoRetornoDb(admin: SupabaseClient): GatilhoRetornoDb {
  return {
    async carregaPointersDeRetorno(orgId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, organization_id, active_version_id, trigger_config, surface")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: PointerDeRetorno[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
        surface?: string | null;
      }>) {
        // Roteiro de atendimento (0394) é do turno, nunca do relógio: o banco
        // já o prende em gatilho manual, e este corte é a segunda porta.
        if (!row.active_version_id || row.surface === "atendimento") continue;
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "inbound_after_silence") continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          threshold_minutes: parsed.data.params.threshold_minutes,
          segments: parsed.data.params.segments ?? [],
        });
      }
      return pointers;
    },

    async carregaInboundAnterior(orgId, contactId, messageId) {
      const { data, error } = await admin
        .from("messages")
        .select("sent_at")
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .eq("direction", "inbound")
        .neq("id", messageId)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const raw = (data as { sent_at: string | null } | null)?.sent_at;
      if (!raw) return null;
      const at = new Date(raw);
      return Number.isNaN(at.getTime()) ? null : at;
    },

    async carregaEstadoDaConversa(orgId, conversationId, contactId) {
      const { data: conv, error: convErr } = await admin
        .from("conversations")
        .select("is_group, assignee_kind, bot_silenced_until")
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (convErr) throw new Error(convErr.message);
      if (!conv) return null;
      const { data: contato, error: contErr } = await admin
        .from("contacts")
        .select("is_blocked, force_human, tags")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      if (contErr) throw new Error(contErr.message);
      return {
        is_group: Boolean((conv as { is_group: boolean }).is_group),
        is_blocked: Boolean((contato as { is_blocked?: boolean } | null)?.is_blocked),
        force_human: Boolean((contato as { force_human?: boolean } | null)?.force_human),
        assignee_kind: (conv as { assignee_kind: string | null }).assignee_kind,
        bot_silenced_until: (conv as { bot_silenced_until: string | null }).bot_silenced_until,
        tags: Array.isArray((contato as { tags?: string[] } | null)?.tags)
          ? ((contato as { tags: string[] }).tags as string[])
          : [],
      };
    },

    async carregaEnrollmentVivo(orgId, contactId) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("pointer_id")
        .eq("organization_id", orgId)
        .eq("contact_id", contactId)
        .in("status", ["active", "waiting_reply", "paused_handoff", "paused_manual"])
        .maybeSingle();
      if (error) throw new Error(error.message);
      const pointerId = (data as { pointer_id: string } | null)?.pointer_id;
      return pointerId ? { pointer_id: pointerId } : null;
    },

    async carregaNoDeGatilho(orgId, versionId) {
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const graph = flowGraphSchema.parse(data.graph);
      return noDeGatilhoDoGrafo(graph);
    },

    async insereEnrollment(input) {
      const { service_origin: _origin, event_id, ...values } = input;
      const boundary = event_id
        ? await serviceForEvent(admin, input.organization_id, event_id, input.contact_id)
        : null;
      if (!boundary) return { inserted: false, id: null, reason: "stale_origin" };
      const { data, error } = await admin
        .from("followup_enrollments")
        .insert({
          ...values,
          conversation_id: boundary.conversation_id,
          service_boundary: boundary,
        })
        .select("id")
        .maybeSingle();
      if (error) {
        if (error.code === "23505") return { inserted: false, id: null };
        throw new Error(error.message);
      }
      return { inserted: true, id: (data as { id: string } | null)?.id ?? null };
    },

    async insereEventoDoEnrollment(evento) {
      const { error } = await admin.from("followup_enrollment_events").insert(evento);
      if (error && error.code !== "23505") throw new Error(error.message);
    },
  };
}
