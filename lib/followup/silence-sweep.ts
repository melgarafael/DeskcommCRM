import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { StaleServiceBoundaryError, parseServiceBoundary, assertCurrentServiceBoundary, type ServiceBoundary } from "@/lib/atendimento/fronteira";
/**
 * Gatilho de SILÊNCIO (Task 8.1) — TIME-DRIVEN, não event-driven. Roda como
 * uma varredura periódica dentro do MESMO tick do cron
 * `app/api/v1/cron/followup-flow-worker/route.ts`, lado a lado com
 * `runFollowupTick` (lib/followup/engine.ts) — decisão de arquitetura já
 * tomada (ver HANDOFF): silêncio não tem um EVENTO que o dispare (é ausência
 * de evento por um período), então não pertence a `reactivity.ts` (que reage
 * a linhas de `event_log`).
 *
 * Fluxo por tick: acha pointers `status='active'` com `trigger_config.kind=
 * 'silence'` (de TODAS as orgs — mesmo design cross-org do
 * `fn_claim_due_followup_enrollments`) → GATEIA cada um via
 * `isPointerEnabledForAutomaticTrigger` (Task 7.2 — só enrolla se algum
 * agente PUBLICADO da org tem esse pointer habilitado) → acha contatos
 * silenciosos da org (sem inbound há >= threshold_minutes) → cria 1
 * enrollment por (pointer, contato) qualificado, nascendo no nó `trigger` do
 * grafo pinado com `next_eval_at=now`. Como `runSilenceSweep` roda DEPOIS de
 * `runFollowupTick` no MESMO tick do cron (route.ts), esse enrollment recém-
 * criado só é reclamado no PRÓXIMO tick (~1min depois), não neste.
 *
 * Idempotência + exclusividade: o índice único `idx_followup_enrollments_one_live`
 * é ORG-WIDE `(organization_id, contact_id)` (migration 0062, Task 8.6) — um
 * contato já vivo em QUALQUER fluxo da org barra novo enrollment (1 follow-up
 * vivo por lead), 23505 vira skip silencioso (`insertEnrollment` devolve
 * `inserted:false`), nunca erro. Um contato que COMPLETOU ou foi cancelado
 * pode ser re-enrollado na varredura seguinte se continuar silencioso —
 * aceitável no MVP, sem cooldown table.
 *
 * agent_id: cada pointer é gateado por `resolveAgentForAutomaticTrigger`, que
 * devolve o agente publicado que ARMA o pointer (menor uuid se >1) — esse
 * agent_id é PINADO no enrollment (persona + exibição na fila). `null` = gate-out.
 *
 * `segments`: única primitiva de segmentação já modelada no schema é
 * `contacts.tags` (GIN index `idx_contacts_tags_gin` já existe) — interpretado
 * como overlap entre `trigger_config.params.segments` e `contacts.tags`.
 * `segments` vazio/ausente = todos os contatos silenciosos da org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import {
  decidirElegibilidade,
  montarEstadoDeElegibilidade,
  ttlDaAutorizacaoMs,
} from "@/lib/ai/elegibilidade/gate";
import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import { resolveAgentForAutomaticTrigger, type FollowupGateDb } from "./agent-followup-gate";

export interface SilencePointer {
  id: string;
  organization_id: string;
  active_version_id: string;
  threshold_minutes: number;
  segments: string[];
}

/** DB surface o sweep precisa — narrow por consumidor (mesma doutrina de `AdminClient`/`ReactivityAdminClient`/`FollowupGateDb`). */
export interface SilenceSweepDb {
  /** Pointers ativos com trigger_config.kind='silence', de TODAS as orgs. */
  loadActiveSilencePointers(): Promise<SilencePointer[]>;
  /** Contact ids da org sem inbound desde `cutoffIso` (inclusive); `segments` vazio = todos. */
  loadSilentContactIds(orgId: string, cutoffIso: string, segments: string[]): Promise<string[]>;
  /** id do nó `trigger` do grafo pinado da version; `null` se version/nó não existir (defensivo — não deveria acontecer, validate-publish garante 1 trigger). */
  loadTriggerNodeId(orgId: string, versionId: string): Promise<string | null>;
  /** Insere o enrollment nascendo no nó trigger; `inserted:false` = 23505 (já vivo nesse pointer) → skip. */
  insertEnrollment(input: {
    organization_id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    current_node_id: string;
    next_eval_at: string;
    agent_id: string | null;
  }): Promise<{ inserted: boolean }>;
}

export interface SilenceSweepSummary {
  pointers_scanned: number;
  pointers_gated_out: number;
  enrolled: number;
  skipped_existing: number;
}

export interface SilenceSweepDeps {
  db: SilenceSweepDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

export async function runSilenceSweep(deps: SilenceSweepDeps): Promise<SilenceSweepSummary> {
  const { db, gateDb, clock } = deps;
  const summary: SilenceSweepSummary = {
    pointers_scanned: 0,
    pointers_gated_out: 0,
    enrolled: 0,
    skipped_existing: 0,
  };

  const pointers = await db.loadActiveSilencePointers();
  summary.pointers_scanned = pointers.length;

  // Memoiza a resolução do agente por pointer dentro desta varredura — nada
  // impede 2 pointers silence na mesma org, e a query do gate já é 1 por org
  // (não precisa repetir). `null` = gate-out (nenhum agente publicado arma o
  // pointer); qualquer agent_id = habilitado E já pinado (o mesmo id que vai
  // pro enrollment). Colapsa gate + pick numa chamada só (Task 8.6).
  const agentCache = new Map<string, Promise<string | null>>();
  const resolveAgent = (orgId: string, pointerId: string): Promise<string | null> => {
    const key = `${orgId}:${pointerId}`;
    let hit = agentCache.get(key);
    if (!hit) {
      hit = resolveAgentForAutomaticTrigger(gateDb, orgId, pointerId);
      agentCache.set(key, hit);
    }
    return hit;
  };

  for (const pointer of pointers) {
    const agentId = await resolveAgent(pointer.organization_id, pointer.id);
    if (agentId === null) {
      summary.pointers_gated_out++;
      continue;
    }

    const triggerNodeId = await db.loadTriggerNodeId(pointer.organization_id, pointer.active_version_id);
    if (!triggerNodeId) continue;

    const cutoffIso = new Date(clock().getTime() - pointer.threshold_minutes * 60_000).toISOString();
    const contactIds = await db.loadSilentContactIds(pointer.organization_id, cutoffIso, pointer.segments);
    const nextEvalAt = clock().toISOString();

    for (const contactId of contactIds) {
      const { inserted } = await db.insertEnrollment({
        organization_id: pointer.organization_id,
        pointer_id: pointer.id,
        version_id: pointer.active_version_id,
        contact_id: contactId,
        current_node_id: triggerNodeId,
        next_eval_at: nextEvalAt,
        agent_id: agentId,
      });
      if (inserted) summary.enrolled++;
      else summary.skipped_existing++;
    }
  }

  return summary;
}

type ContactEmbed =
  | {
      tags: string[] | null;
      is_blocked: boolean | null;
      ai_authorized_at: string | null;
      phone_number: string | null;
    }
  | null;

/** Production adapter: `SilenceSweepDb` sobre o client service-role real. */
export function createSupabaseSilenceSweepDb(admin: SupabaseClient): SilenceSweepDb {
  const origins = new Map<string, ServiceBoundary>();
  return {
    async loadActiveSilencePointers() {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, organization_id, active_version_id, trigger_config")
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: SilencePointer[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
      }>) {
        if (!row.active_version_id) continue;
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "silence") continue;
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

    async loadSilentContactIds(orgId, cutoffIso, segments) {
      // last_inbound_at é POR CONVERSA; o enrollment é POR CONTATO — reduz
      // client-side pro MAIS RECENTE `last_inbound_at` entre as conversas do
      // contato (um contato com 2+ channel_sessions não pode ser marcado
      // silencioso por causa da conversa mais antiga se a mais nova respondeu).
      //
      // `.not("status", "in", ...)` exclui conversas CLOSED/ARCHIVED — um humano
      // que encerrou a conversa não deveria ver um follow-up automático chegar
      // depois. Sem isto, o sweep contava `last_inbound_at` de QUALQUER
      // conversa, inclusive uma que um humano já fechou de propósito — medido
      // ao desenhar o primeiro fluxo de silêncio real (tenant YADEA): o gatilho
      // só faz sentido enquanto "o fluxo da conversa ainda está ativo".
      const { data, error } = await admin
        .from("conversations")
        .select(
          "id, service_revision, current_demanda_id, demandas!conversations_current_demanda_id_fkey(revision,fechada_em), status, messages!messages_conversation_id_fkey(organization_id,contact_id,conversation_id,service_revision,demanda_id,demanda_revision,sent_at), contact_id, last_inbound_at, contacts:contact_id(tags, is_blocked, ai_authorized_at, phone_number), sessao:channel_session_id(metadata)",
        )
        .eq("organization_id", orgId).eq("demandas.organization_id", orgId)
        .eq("contacts.organization_id", orgId).eq("sessao.organization_id", orgId)
        .eq("messages.organization_id", orgId).eq("messages.direction", "inbound")
        .not("messages.service_revision", "is", null)
        .order("sent_at", { referencedTable: "messages", ascending: false })
        .limit(1, { referencedTable: "messages" })
        .not("last_inbound_at", "is", null)
        .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`);
      if (error) throw new Error(error.message);

      type Row = {
        id: string; service_revision: number; current_demanda_id: string | null; demandas: { revision: number; fechada_em: string | null } | null;
        status: string; messages: Array<ServiceBoundary & { sent_at: string }>;
        contact_id: string;
        last_inbound_at: string;
        contacts: ContactEmbed;
        sessao: { metadata: Record<string, unknown> | null } | null;
      };
      const cutoff = new Date(cutoffIso).getTime();
      const agora = new Date();
      const ttlMs = ttlDaAutorizacaoMs(process.env);
      const latest = new Map<
        string,
        { boundary: ServiceBoundary; at: number; tags: string[]; blocked: boolean; permitidoPeloGate: boolean }
      >();
      for (const row of (data ?? []) as unknown as Row[]) {
        const source = row.messages?.[0];
        const boundary = parseServiceBoundary(source);
        if (!source || !boundary) continue;
        try {
          assertCurrentServiceBoundary(boundary, { organization_id: orgId, contact_id: row.contact_id,
            conversation_id: row.id, service_revision: row.service_revision, demanda_id: row.current_demanda_id,
            demanda_revision: row.demandas?.revision ?? null, status: row.status, demanda_fechada_em: row.demandas?.fechada_em ?? null });
        } catch { continue; }
        const at = new Date(source.sent_at).getTime();
        const prev = latest.get(row.contact_id);
        if (!prev || at > prev.at) {
          const metadata = row.sessao?.metadata ?? {};
          const acesso = decidirElegibilidade(
            montarEstadoDeElegibilidade({
              aiGate: metadata.ai_gate,
              aiGateMode: metadata.ai_gate_mode,
              aiTestPhoneNumbers: metadata.ai_test_phone_numbers,
              contactPhoneNumber: row.contacts?.phone_number ?? null,
              forceHuman: false,
              assigneeKind: null,
              botSilencedUntil: null,
              aiAuthorizedAt: row.contacts?.ai_authorized_at ?? null,
              agora,
              ttlMs,
            }),
          );
          latest.set(row.contact_id, {
            boundary, at,
            tags: row.contacts?.tags ?? [],
            blocked: row.contacts?.is_blocked ?? false,
            permitidoPeloGate: acesso.permite,
          });
        }
      }

      const silentIds: string[] = [];
      for (const [contactId, v] of latest) {
        if (v.blocked) continue;
        // A mesma regra do atendimento de entrada vale antes de criar o
        // enrollment: no pré-go-live só testadores avançam; no allowlist comum
        // continua valendo a autorização temporária da origem.
        if (!v.permitidoPeloGate) continue;
        if (v.at > cutoff) continue; // conversou depois do corte — não é silêncio
        if (segments.length > 0 && !segments.some((s) => v.tags.includes(s))) continue;
        silentIds.push(contactId);
        origins.set(`${orgId}:${contactId}`, v.boundary);
      }
      return silentIds;
    },

    async loadTriggerNodeId(orgId, versionId) {
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const graph = flowGraphSchema.parse(data.graph);
      return graph.nodes.find((n) => n.type === "trigger")?.id ?? null;
    },

    async insertEnrollment(input) {
      // 23505 aqui agora é o índice ORG-WIDE (organization_id, contact_id) —
      // um contato já vivo em QUALQUER fluxo da org barra este insert (Task
      // 8.6: 1 follow-up vivo por lead). Vira skip silencioso, nunca erro.
      const boundary = origins.get(`${input.organization_id}:${input.contact_id}`);
      if (!boundary) return { inserted: false };
      try { await assertServiceBoundarySupabase(admin, boundary); } catch (error) {
        if (error instanceof StaleServiceBoundaryError) return { inserted: false }; throw error;
      }
      const protection=(await protecaoAgendaSupabase(admin,input.organization_id,[input.contact_id])).get(input.contact_id);
      if(protection?.motivo==="leitura_indisponivel") throw new Error("agenda_read_failed");
      if(protection?.adiar) return {inserted:false};
      const { error } = await admin.from("followup_enrollments").insert({ ...input, conversation_id: boundary.conversation_id, service_boundary: boundary });
      if (error) {
        if (error.code === "23505") return { inserted: false };
        throw new Error(error.message);
      }
      return { inserted: true };
    },
  };
}
