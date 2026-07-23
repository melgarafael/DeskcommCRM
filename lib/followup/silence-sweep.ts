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
 * Idempotência: o índice único `idx_followup_enrollments_one_live`
 * (pointer_id, contact_id) já impede duplicata VIVA — 23505 vira skip
 * silencioso (`insertEnrollment` devolve `inserted:false`), nunca erro. Um
 * contato que COMPLETOU ou foi cancelado pode ser re-enrollado na varredura
 * seguinte se continuar silencioso — aceitável no MVP, sem cooldown table.
 *
 * `segments`: única primitiva de segmentação já modelada no schema é
 * `contacts.tags` (GIN index `idx_contacts_tags_gin` já existe) — interpretado
 * como overlap entre `trigger_config.params.segments` e `contacts.tags`.
 * `segments` vazio/ausente = todos os contatos silenciosos da org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import { isPointerEnabledForAutomaticTrigger, type FollowupGateDb } from "./agent-followup-gate";

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

  // Memoiza o gate por pointer dentro desta varredura — nada impede 2 pointers
  // silence na mesma org, e o gate já é 1 query por org (não precisa repetir).
  const gateCache = new Map<string, Promise<boolean>>();
  const isGated = (orgId: string, pointerId: string): Promise<boolean> => {
    const key = `${orgId}:${pointerId}`;
    let hit = gateCache.get(key);
    if (!hit) {
      hit = isPointerEnabledForAutomaticTrigger(gateDb, orgId, pointerId);
      gateCache.set(key, hit);
    }
    return hit;
  };

  for (const pointer of pointers) {
    const enabled = await isGated(pointer.organization_id, pointer.id);
    if (!enabled) {
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
      });
      if (inserted) summary.enrolled++;
      else summary.skipped_existing++;
    }
  }

  return summary;
}

type ContactEmbed = { tags: string[] | null; is_blocked: boolean | null } | null;

/** Production adapter: `SilenceSweepDb` sobre o client service-role real. */
export function createSupabaseSilenceSweepDb(admin: SupabaseClient): SilenceSweepDb {
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
      const { data, error } = await admin
        .from("conversations")
        .select("contact_id, last_inbound_at, contacts:contact_id(tags, is_blocked)")
        .eq("organization_id", orgId)
        .not("last_inbound_at", "is", null);
      if (error) throw new Error(error.message);

      type Row = { contact_id: string; last_inbound_at: string; contacts: ContactEmbed };
      const cutoff = new Date(cutoffIso).getTime();
      const latest = new Map<string, { at: number; tags: string[]; blocked: boolean }>();
      for (const row of (data ?? []) as unknown as Row[]) {
        const at = new Date(row.last_inbound_at).getTime();
        const prev = latest.get(row.contact_id);
        if (!prev || at > prev.at) {
          latest.set(row.contact_id, {
            at,
            tags: row.contacts?.tags ?? [],
            blocked: row.contacts?.is_blocked ?? false,
          });
        }
      }

      const silentIds: string[] = [];
      for (const [contactId, v] of latest) {
        if (v.blocked) continue;
        if (v.at > cutoff) continue; // conversou depois do corte — não é silêncio
        if (segments.length > 0 && !segments.some((s) => v.tags.includes(s))) continue;
        silentIds.push(contactId);
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
      const { error } = await admin.from("followup_enrollments").insert(input);
      if (error) {
        if (error.code === "23505") return { inserted: false };
        throw new Error(error.message);
      }
      return { inserted: true };
    },
  };
}
