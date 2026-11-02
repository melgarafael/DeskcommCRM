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
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { filtrarCandidatosExcluidos } from "@/lib/escalacao/devolucao-ao-rodizio";
import { logger } from "@/lib/logger";
import {
  decideRouting,
  resolverRoteamentoPorNumero,
  type RegraDoNumero,
} from "@/lib/routing/decide";
import { motivoParaNaoRotear, type MotivoDoCaso } from "@/lib/routing/caso-da-conversa";
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
  | "skipped_contato_pessoal"
  /** #3717: o caso mais recente da conversa não pede uma pessoa agora. */
  | "skipped_caso_sem_humano"
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
  skipped_contato_pessoal: 0,
  skipped_caso_sem_humano: 0,
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
  const { data: abandoned, error: recoveryError } = await admin
    .from("event_log")
    .select("id, organization_id, updated_at")
    .eq("event_type", ROUTING_EVENT_TYPE)
    .eq("status", "processing")
    .lte("updated_at", new Date(now.getTime() - 300_000).toISOString())
    .limit(batchSize);
  if (recoveryError) {
    summary.errors.push("routing_recovery_failed");
    return summary;
  }
  for (const previous of abandoned ?? []) {
    const { error } = await admin
      .from("event_log")
      .update({ status: "pending", next_attempt_at: now.toISOString() })
      .eq("organization_id", previous.organization_id)
      .eq("id", previous.id)
      .eq("status", "processing")
      .eq("updated_at", previous.updated_at);
    if (error) summary.errors.push("routing_recovery_failed");
  }
  const { data: rawEvents, error: pullErr } = await admin
    .from("event_log")
    .select(
      "id, organization_id, payload, metadata, consumed_by, attempts, next_attempt_at, status",
    )
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

  if (
    !conversationId ||
    !z.string().uuid().safeParse(conversationId).success ||
    orgId !== event.organization_id
  ) {
    await markDone(event, "skipped_invalid_payload");
    return "skipped_invalid_payload";
  }

  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select(
      "id, organization_id, contact_id, channel_session_id, assigned_to_user_id, status, metadata, last_inbound_at",
    )
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (convError) throw new Error(convError.message);
  if (!conv || !["open", "pending", "claimed", "ai_handling"].includes(conv.status)) {
    await markDone(event, "skipped_conv_missing");
    return "skipped_conv_missing";
  }

  // Contato pessoal não distribui (spec 21, caminho 9): depois da leitura da
  // conversa — o pulo precisa do contato, que só ela tem.
  const { data: contato } = await admin
    .from("contacts")
    .select("is_personal")
    .eq("id", conv.contact_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if ((contato as { is_personal?: boolean } | null)?.is_personal === true) {
    await markDone(event, "skipped_contato_pessoal");
    return "skipped_contato_pessoal";
  }

  // O CASO DA CONVERSA (#3717): a pergunta que a fila nunca fazia. Fica AQUI —
  // depois de a conversa existir no pool e de não ser contato pessoal (não
  // gastar query em quem já saiu) —, e antes de qualquer leitura de config ou
  // de candidatos: o caso barra a conversa ANTES de o rodízio montar a lista.
  const motivoDoCaso = await motivoDoCasoParaRoteamento(admin, orgId, {
    id: conversationId,
    last_inbound_at: (conv as { last_inbound_at?: string | null }).last_inbound_at ?? null,
  });

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

  // Regra POR NÚMERO (#2331): o canal pode ter modo próprio e um atendente de
  // destino padrão. Número sem regra (policy ausente ou colunas nulas) cai no
  // comportamento da organização — resolverRoteamentoPorNumero é pura e o
  // resultado é o mesmo que o worker já usava quando não havia coluna.
  const regraDoNumero = await carregarRegraDoNumero(admin, orgId, conv.channel_session_id);
  const efetivo = resolverRoteamentoPorNumero(config, regraDoNumero);

  const alreadyAssigned = Boolean(conv.assigned_to_user_id);
  // O destino padrão NÃO depende da lista de elegíveis do modo: é entrega
  // direta. Por isso só carregamos elegíveis quando o modo vai distribuir.
  const viaDestinoPadrao = !alreadyAssigned && Boolean(efetivo.defaultAssigneeUserId);
  let eligibles: Awaited<ReturnType<typeof loadEligibleAttendants>> = [];
  if (
    !alreadyAssigned &&
    !viaDestinoPadrao &&
    (efetivo.mode === "round_robin" || efetivo.mode === "load")
  ) {
    try {
      eligibles = await loadEligibleAttendants(admin, orgId, now, {
        kind: "conversation_channel",
        channelSessionId: conv.channel_session_id,
      });
    } catch (error) {
      if (!(error instanceof InvalidRoutingChannel)) throw error;
      await notice(orgId, conversationId, "invalid_channel");
      await markDone(event, "skipped_invalid_channel");
      return "skipped_invalid_channel";
    }
  }

  // A EXCLUSÃO DE 24 H DA DEVOLUÇÃO AO RODÍZIO (issue #2985). Quem recebeu esta
  // conversa do rodízio e não respondeu no prazo fica fora dela por um dia
  // (`conversations.metadata.devolucao_ao_rodizio`, escrito pelo cron
  // `rodizio-devolucao`). Sem este corte, o cron devolveria a conversa e o
  // próximo tick deste worker a entregaria à MESMA pessoa — numa instalação com
  // um atendente só, sempre ela. A regra da marca é pura e mora em
  // `lib/escalacao/devolucao-ao-rodizio.ts`.
  const elegiveis = filtrarCandidatosExcluidos(eligibles, conv.metadata, now.getTime());

  const action = decideRouting({
    mode: efetivo.mode,
    alreadyAssigned,
    eligibles: elegiveis,
    config,
    defaultAssigneeUserId: efetivo.defaultAssigneeUserId,
    attempts: event.attempts,
    now,
    motivoDoCaso,
  });

  switch (action.kind) {
    case "assign": {
      // O destino padrão não passou pela régua de elegibilidade (não é
      // rodízio): vai sem snapshot de jornada — a RPC checa disponibilidade e
      // capacidade, mas não compara jornada de quem ninguém escolheu.
      const schedule = viaDestinoPadrao
        ? null
        : (eligibles.find((candidate) => candidate.userId === action.userId)?.scheduleSnapshot ??
          {});
      const { data: result, error } = await admin.rpc("fn_channel_routing_claim", {
        p_org: orgId,
        p_conversation: conversationId,
        p_channel: conv.channel_session_id,
        p_user: action.userId,
        p_reason: "routing",
        p_schedule: schedule,
      });
      if (error) throw new Error(`fn_channel_routing_claim: ${error.message}`);
      if (result === "already_assigned" || result === "conversation_changed") {
        await markDone(event, "assign_lost_race");
        return "assign_lost_race";
      }
      if (result !== "assigned") {
        if (
          !["candidate_revoked", "candidate_not_allowed", "capacity_changed"].includes(
            String(result),
          )
        ) {
          throw new Error("routing_claim_invalid_result");
        }
        await requeueEvent(event, now, Math.min(event.attempts + 1, config.max_retries), {
          reason: result,
        });
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
            : action.reason === "caso_aguardando_cliente" || action.reason === "caso_encerrado"
              ? "skipped_caso_sem_humano"
              : "skipped_unsupported_mode";
      if (action.reason.startsWith("unsupported_mode")) {
        logger.warn("[routing-worker] modo não suportado (post-MVP) — no-op", {
          organization_id: orgId,
          mode: config.mode,
        });
      }
      // #3717: o motivo do caso vai para o `metadata` do evento. As duas causas
      // ("esperando o cliente" × "caso concluído") viram o MESMO outcome de
      // contagem — o que se mede é "quantas conversas a fila recusou por causa
      // do caso" —, e a distinção fica no evento para quem for investigar.
      await markDone(
        event,
        outcome,
        outcome === "skipped_caso_sem_humano" ? { motivo_do_caso: action.reason } : {},
      );
      return outcome;
    }
    case "requeue": {
      if (action.attempts >= config.max_retries) await notice(orgId, conversationId, "no_eligible");
      await requeueEvent(
        event,
        now,
        action.attempts,
        { reason: "no_eligible" },
        action.nextAttemptAt,
      );
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
  if (error)
    logger.warn("[routing-worker] markDone failed", { event_id: event.id, error: error.message });
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
  if (error)
    logger.warn("[routing-worker] requeue failed", { event_id: event.id, error: error.message });
}

async function notice(orgId: string, conversationId: string, reason: string): Promise<void> {
  const { error } = await createAdminClient().rpc("fn_routing_unassigned_notice", {
    p_org: orgId,
    p_conversation: conversationId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Lê a regra do NÚMERO (#2331) de `channel_routing_policies`.
 *
 * Ausência de policy = número sem regra própria, e é o estado de TODA
 * instalação existente: as duas colunas nasceram nulas. Devolver `null` (e não
 * um objeto default) é o que faz o worker cair no comportamento da organização.
 */
export async function carregarRegraDoNumero(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  channelSessionId: string | null,
): Promise<RegraDoNumero | null> {
  if (!channelSessionId) return null;
  const { data, error } = await admin
    .from("channel_routing_policies")
    .select("distribution_mode, default_assignee_user_id")
    .eq("organization_id", orgId)
    .eq("channel_session_id", channelSessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { distribution_mode: string | null; default_assignee_user_id: string | null };
  return {
    distribution_mode: (row.distribution_mode ?? null) as RegraDoNumero["distribution_mode"],
    default_assignee_user_id: row.default_assignee_user_id ?? null,
  };
}

/**
 * Lê o caso MAIS RECENTE da conversa e responde se ele tira a conversa da fila
 * (issue #3717). `null` = a fila pode distribuir.
 *
 * ## Por que a leitura é separada da regra
 *
 * `motivoParaNaoRotear` (`lib/routing/caso-da-conversa.ts`) é puro e não sabe o
 * que é um banco; aqui só existe a pergunta "qual é a linha mais recente?".
 * `agent_cases_conv_idx` (organization_id, conversation_id) existe desde a 0066
 * — não há índice novo a criar.
 *
 * ## Falha de leitura distribui (falha ABERTA)
 *
 * Se o SELECT do caso estourar, o worker segue para a decisão com `null`, e não
 * derruba o evento. Mesma escolha de `operator-turn.ts:686` ("na dúvida o aviso
 * sai, que é o erro barato"): subir a exceção reenfileiraria o evento e deixaria
 * a conversa sem dono — o desfecho caro. O erro sai no log, com a org e a
 * conversa, para não sumir.
 */
export async function motivoDoCasoParaRoteamento(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  conversa: { id: string; last_inbound_at?: string | null },
): Promise<MotivoDoCaso | null> {
  const { data, error } = await admin
    .from("agent_cases")
    .select("status, closed_at, updated_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversa.id)
    // O MAIS RECENTE, com desempate determinístico: `created_at` sozinho pode
    // empatar (dois casos no mesmo instante) e dois ticks leriam linhas
    // diferentes para a mesma conversa.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn("[routing-worker] não consegui ler o caso da conversa — seguindo para a fila", {
      organization_id: orgId,
      conversation_id: conversa.id,
      error: error.message,
    });
    return null;
  }
  const caso = data as {
    status: string;
    closed_at: string | null;
    updated_at: string | null;
  } | null;
  return motivoParaNaoRotear(
    caso
      ? {
          status: caso.status,
          encerradoEm: caso.closed_at ?? null,
          atualizadoEm: caso.updated_at ?? null,
        }
      : null,
    conversa.last_inbound_at ?? null,
  );
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
