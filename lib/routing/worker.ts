/**
 * Worker de roteamento de conversas (G5-02 — AT-03, spec 13 §5).
 *
 * Doutrina: trigger NUNCA faz HTTP. A entrada da conversa na fila emite
 * `conversation.routing_requested` em `event_log` (trigger AFTER INSERT em
 * conversations, migration 0040); ESTE worker (cron TS) drena o evento, resolve
 * o modo da org e atribui — como service_role (admin client bypassa RLS, então
 * TODA query filtra organization_id vindo do payload confiável do evento).
 *
 * Mecânica de claim = mesma do agent-dispatcher: CAS status pending→processing,
 * `consumed_by` marca o consumidor, `next_attempt_at`/`attempts` reenfileiram.
 * A lógica de decisão (manual/round_robin/no-eligible/replay) é pura em
 * lib/routing/decide.ts; aqui só há I/O.
 */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { decideRouting } from "@/lib/routing/decide";
import { loadEligibleAttendants, InvalidRoutingChannel } from "@/lib/routing/eligibles";
import { routingConfigSchema } from "@/lib/schemas/routing";

export const ROUTING_WORKER_KEY = "worker.routing.v1";
export const ROUTING_EVENT_TYPE = "conversation.routing_requested";

const DEFAULT_BATCH_SIZE = 100;

export type RoutingOutcome =
  | "assigned"
  | "skipped_manual"
  | "skipped_already_assigned"
  | "skipped_unsupported_mode"
  | "requeued_no_eligible"
  | "skipped_invalid_channel"
  | "skipped_conv_missing"
  | "skipped_invalid_payload"
  | "assign_lost_race"
  | "error";

export interface RoutingSummary {
  batch_size: number;
  outcomes: Record<RoutingOutcome, number>;
  errors: string[];
}

interface EventRow {
  id: string;
  organization_id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  consumed_by: string[];
  attempts: number;
  claimed_at?: string;
}

const EMPTY_OUTCOMES = (): Record<RoutingOutcome, number> => ({
  assigned: 0,
  skipped_manual: 0,
  skipped_already_assigned: 0,
  skipped_unsupported_mode: 0,
  requeued_no_eligible: 0,
  skipped_invalid_channel: 0,
  skipped_conv_missing: 0,
  skipped_invalid_payload: 0,
  assign_lost_race: 0,
  error: 0,
});

export interface RoutingWorkerOptions {
  batchSize?: number;
  /** Relógio injetável (testes) — usado na elegibilidade (horário) e no backoff. */
  now?: Date;
}

export async function runRoutingWorker(opts: RoutingWorkerOptions = {}): Promise<RoutingSummary> {
  const admin = createAdminClient();
  const now = opts.now ?? new Date();
  const batchSize = Math.min(Math.max(opts.batchSize ?? DEFAULT_BATCH_SIZE, 1), 500);
  const summary: RoutingSummary = { batch_size: 0, outcomes: EMPTY_OUTCOMES(), errors: [] };

  // Recupera execução interrompida sem criar outro evento. O timestamp do
  // claim cerca o fechamento: um worker antigo não conclui a nova tentativa.
  const { data: abandoned, error: recoveryError } = await admin.from("event_log")
    .select("id, organization_id, updated_at").eq("event_type", ROUTING_EVENT_TYPE)
    .eq("status", "processing").lte("updated_at", new Date(now.getTime() - 300_000).toISOString()).limit(batchSize);
  if (recoveryError) { summary.errors.push("routing_recovery_failed"); return summary; }
  for (const previous of abandoned ?? []) {
    const { error } = await admin.from("event_log").update({ status: "pending", next_attempt_at: now.toISOString() })
      .eq("organization_id", previous.organization_id).eq("id", previous.id)
      .eq("status", "processing").eq("updated_at", previous.updated_at);
    if (error) summary.errors.push("routing_recovery_failed");
  }
  const { data: rawEvents, error: pullErr } = await admin
    .from("event_log")
    .select("id, organization_id, payload, metadata, consumed_by, attempts, next_attempt_at, status")
    .eq("event_type", ROUTING_EVENT_TYPE)
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (pullErr) {
    summary.errors.push(`event_log_pull_failed: ${pullErr.message}`);
    return summary;
  }

  const events = (rawEvents ?? []).filter(
    (e) => !(Array.isArray(e.consumed_by) && e.consumed_by.includes(ROUTING_WORKER_KEY)),
  ) as EventRow[];

  for (const event of events) {
    const claimed = await claimEvent(event);
    if (!claimed) continue;
    summary.batch_size += 1;
    try {
      const outcome = await processEvent(event, now);
      summary.outcomes[outcome] += 1;
    } catch (err) {
      summary.outcomes.error += 1;
      const detail = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${event.id}:${detail}`);
      logger.error("[routing-worker] processEvent threw", {
        event_id: event.id,
        organization_id: event.organization_id,
        error: detail,
      });
      await requeueEvent(event, now, event.attempts + 1, { error: detail.slice(0, 200) });
    }
  }

  return summary;
}

async function processEvent(event: EventRow, now: Date): Promise<RoutingOutcome> {
  const admin = createAdminClient();
  const payload = event.payload ?? {};
  const orgId = strOrNull(payload.organization_id) ?? event.organization_id;
  const conversationId = strOrNull(payload.conversation_id);

  if (!conversationId || !z.string().uuid().safeParse(conversationId).success || orgId !== event.organization_id) {
    await markDone(event, "skipped_invalid_payload");
    return "skipped_invalid_payload";
  }

  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select("id, organization_id, contact_id, channel_session_id, assigned_to_user_id, status")
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (convError) throw new Error(convError.message);
  if (!conv || !["open", "pending", "claimed", "ai_handling"].includes(conv.status)) {
    await markDone(event, "skipped_conv_missing");
    return "skipped_conv_missing";
  }

  // organizations.settings.routing → Zod (default manual; knobs = config, não hardcode).
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) throw new Error(orgError.message);
  if (!org) throw new Error("routing_organization_missing");
  const settings = (org?.settings ?? {}) as { routing?: unknown };
  const config = routingConfigSchema.parse(settings.routing ?? {});

  const alreadyAssigned = Boolean(conv.assigned_to_user_id);
  let eligibles: Awaited<ReturnType<typeof loadEligibleAttendants>> = [];
  if (!alreadyAssigned && config.mode === "round_robin") {
    try {
      eligibles = await loadEligibleAttendants(admin, orgId, now, {
        kind: "conversation_channel", channelSessionId: conv.channel_session_id,
      });
    } catch (error) {
      if (!(error instanceof InvalidRoutingChannel)) throw error;
      await notice(orgId, conversationId, "invalid_channel");
      await markDone(event, "skipped_invalid_channel");
      return "skipped_invalid_channel";
    }
  }

  const action = decideRouting({
    mode: config.mode,
    alreadyAssigned,
    eligibles,
    config,
    attempts: event.attempts,
    now,
  });

  switch (action.kind) {
    case "assign": {
      const { data: result, error } = await admin.rpc("fn_channel_routing_claim", {
        p_org: orgId, p_conversation: conversationId, p_channel: conv.channel_session_id,
        p_user: action.userId, p_reason: "routing",
        p_schedule: eligibles.find((candidate) => candidate.userId === action.userId)?.scheduleSnapshot ?? {},
      });
      if (error) throw new Error(`fn_channel_routing_claim: ${error.message}`);
      if (result === "already_assigned" || result === "conversation_changed") {
        await markDone(event, "assign_lost_race");
        return "assign_lost_race";
      }
      if (result !== "assigned") {
        if (!["candidate_revoked", "candidate_not_allowed", "capacity_changed"].includes(String(result))) {
          throw new Error("routing_claim_invalid_result");
        }
        await requeueEvent(event, now, Math.min(event.attempts + 1, config.max_retries), { reason: result });
        return "requeued_no_eligible";
      }
      const leads = await adotarLeadsDoContato(
        admin,
        orgId,
        strOrNull((conv as { contact_id?: unknown }).contact_id),
        action.userId,
      );
      await markDone(event, "assigned", {
        assigned_to_user_id: action.userId,
        leads_adotados: leads,
      });
      return "assigned";
    }
    case "skip": {
      const outcome: RoutingOutcome =
        action.reason === "manual_mode"
          ? "skipped_manual"
          : action.reason === "already_assigned"
            ? "skipped_already_assigned"
            : "skipped_unsupported_mode";
      if (action.reason.startsWith("unsupported_mode")) {
        logger.warn("[routing-worker] modo não suportado (post-MVP) — no-op", {
          organization_id: orgId,
          mode: config.mode,
        });
      }
      await markDone(event, outcome);
      return outcome;
    }
    case "requeue": {
      if (action.attempts >= config.max_retries) await notice(orgId, conversationId, "no_eligible");
      await requeueEvent(event, now, action.attempts, { reason: "no_eligible" }, action.nextAttemptAt);
      return "requeued_no_eligible";
    }

  }
}

// --- event lifecycle (mesma mecânica do agent-dispatcher; status ∈ pending|processing|done|dead) ---

async function claimEvent(event: EventRow): Promise<boolean> {
  const admin = createAdminClient();
  event.claimed_at = new Date().toISOString();
  const { data, error } = await admin
    .from("event_log")
    .update({ status: "processing", updated_at: event.claimed_at })
    .eq("id", event.id)
    .eq("organization_id", event.organization_id)
    .eq("status", "pending")
    .select("id, updated_at")
    .maybeSingle();
  if (error) {
    logger.warn("[routing-worker] claim failed", { event_id: event.id, error: error.message });
    return false;
  }
  if (data) event.claimed_at = data.updated_at;
  return Boolean(data);
}

async function markDone(
  event: EventRow,
  outcome: RoutingOutcome,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  const consumed = Array.isArray(event.consumed_by) ? event.consumed_by.slice() : [];
  if (!consumed.includes(ROUTING_WORKER_KEY)) consumed.push(ROUTING_WORKER_KEY);
  const { error } = await admin
    .from("event_log")
    .update({
      status: "done",
      consumed_by: consumed,
      metadata: { ...(event.metadata ?? {}), outcome, handled_by: ROUTING_WORKER_KEY, ...extra },
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id)
    .eq("organization_id", event.organization_id)
    .eq("status", "processing")
    .eq("updated_at", event.claimed_at!);
  if (error) logger.warn("[routing-worker] markDone failed", { event_id: event.id, error: error.message });
}

async function requeueEvent(
  event: EventRow,
  now: Date,
  attempts: number,
  extra: Record<string, unknown>,
  nextAttemptAt?: string,
): Promise<void> {
  const admin = createAdminClient();
  const next = nextAttemptAt ?? new Date(now.getTime() + 60_000).toISOString();
  const { error } = await admin
    .from("event_log")
    .update({
      status: "pending",
      attempts,
      next_attempt_at: next,
      metadata: { ...(event.metadata ?? {}), last_requeue: { ...extra, at: now.toISOString() } },
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id)
    .eq("organization_id", event.organization_id)
    .eq("status", "processing")
    .eq("updated_at", event.claimed_at!);
  if (error) logger.warn("[routing-worker] requeue failed", { event_id: event.id, error: error.message });
}

async function notice(orgId: string, conversationId: string, reason: string): Promise<void> {
  const { error } = await createAdminClient().rpc("fn_routing_unassigned_notice", {
    p_org: orgId, p_conversation: conversationId, p_reason: reason,
  });
  if (error) throw new Error(error.message);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * O rodízio distribui CONVERSA. Sem esta função ele não distribui LEAD — e é o
 * lead que o dono do negócio olha no funil (issue #144).
 *
 * ## Por que isto existe
 *
 * `fn_conversation_assign` grava `conversations.assigned_to_user_id` e não toca
 * em `crm_leads.owner_user_id` (medido: a função inteira só faz `update
 * public.conversations`). Enquanto `visibility_mode` era `all` ou
 * `own_and_unassigned`, ninguém notava: o lead sem dono aparecia para todo
 * mundo. No modo `own` — exatamente o que a issue #144 pede — lead sem dono não
 * aparece para NINGUÉM. O atendente receberia a conversa e o funil dele ficaria
 * vazio. A restrição funcionaria e a fila não existiria.
 *
 * ## As três condições, e por que cada uma
 *
 * Adota só o lead que está `open` (negócio fechado não muda de dono), do
 * `contact_id` da conversa, e **sem dono nenhum** — nem humano (`owner_user_id`)
 * nem agente de IA (`owner_agent_id`). Roubar lead com dono transformaria o
 * rodízio numa reatribuição silenciosa a cada mensagem nova do mesmo contato,
 * que é o oposto de "cada um com a sua carteira".
 *
 * `owner_kind` entra junto com `owner_user_id` de propósito: o CHECK aceita
 * kind nulo, então um lead com dono e sem kind some do filtro por dono e das
 * métricas por kind — drift silencioso já registrado em `leads/_handler.ts`.
 *
 * Best-effort por decisão: a conversa JÁ foi atribuída quando chegamos aqui.
 * Deixar uma exceção subir faria o evento voltar para a fila e tentar atribuir
 * de novo uma conversa que já tem dono — troca um funil incompleto por um
 * retry inútil. O que falhou vira log, e a próxima mensagem do contato tenta
 * de novo.
 */
export async function adotarLeadsDoContato(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  contactId: string | null,
  userId: string,
): Promise<number> {
  if (!contactId) return 0;
  try {
    const { data, error } = await admin
      .from("crm_leads")
      .update({
        owner_user_id: userId,
        owner_kind: "user",
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .eq("status", "open")
      .is("owner_user_id", null)
      .is("owner_agent_id", null)
      .select("id");
    if (error) {
      logger.warn("[routing-worker] não consegui dar dono ao lead do contato", {
        organization_id: orgId,
        contact_id: contactId,
        error: error.message,
      });
      return 0;
    }
    return (data ?? []).length;
  } catch (err) {
    logger.warn("[routing-worker] adoção de lead lançou", {
      organization_id: orgId,
      contact_id: contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
