/**
 * Reatividade do follow-up (Task 5.2, onda 5) — a peça que faz enrollments
 * REAGIREM a inbound, STOP/opt-out e handoff humano (abrir/fechar). É aqui que
 * vive a garantia anti-Tomik: nenhum estado pausado sem consumidor de retomada
 * (spec §4, causa-raiz nº3 do TomikCRM v1).
 *
 * DESVIO DELIBERADO do esboço do brief (documentado no HANDOFF): o brief
 * sugeria um cursor próprio em `watchdog_cursors` drenado DENTRO do tick do
 * `runFollowupTick`. Investiguei o consumidor de `event_log` REALMENTE em
 * produção neste repo — `lib/event-log/dispatcher.ts` + `drain.ts` +
 * `app/api/v1/cron/event-log-drain/route.ts` (roda a cada minuto pelo serviço
 * `scheduler` do kit self-host — ver README.md) — e ele já resolve
 * exatamente este problema: múltiplos consumidores por `event_type`,
 * idempotência via `consumed_by[]` (sem duplo efeito em re-drain), retry com
 * backoff, dead-letter. `watchdog_cursors` tem ZERO consumidores TS neste
 * repo (grep confirmou — infra não usada ainda). Reusar o dispatcher genérico
 * é a doutrina do projeto (ladder: "já existe no codebase → reusa") e dá de
 * graça o requisito "reactivity failure não aborta o tick": como reactivity
 * roda numa rota/cron SEPARADA de `followup-flow-worker`, uma falha aqui
 * literalmente não pode derrubar o tick — isolamento total, não só um
 * try/catch agregando no summary.
 *
 * Este arquivo é a lógica de negócio + interface de DB estreita (mesmo padrão
 * de `engine.ts`/`turn-bridge.ts` — narrow `ReactivityAdminClient`, não
 * `SupabaseClient` direto, pra ficar testável contra o Postgres cru dos
 * invariantes). `lib/followup/reactivity.handler.ts` é o adapter fino que
 * pluga isso no dispatcher (`EventHandler`), registrado em
 * `lib/event-log/register-handlers.ts`.
 *
 * As 4 reações (spec §4):
 *   1. `message.received` (inbound) — se o contato está `is_blocked` (a
 *      detecção de STOP em `lib/waha/ingest.ts` já setou a coluna ANTES de
 *      emitir este evento — mesma request, sequencial): cancela TUDO
 *      (`opted_out`). Senão, para enrollments `waiting_reply` do contato:
 *      `cancel_on_reply` no `trigger_config` do pointer → cancela
 *      (`replied`); senão, acorda (marker `inbound_woke` + `next_eval_at=now`).
 *      Inscrições `active` no nó `wait` seguem a mesma política: com
 *      `cancel_on_reply`, cancelam; sem ela, acordam e cortam o timer.
 *   2. `ai.handoff_triggered` (handoff aberto) — já emitido em produção por
 *      `lib/ai/handoff/orchestrator.ts` (triggerHandoff, chamado por
 *      workers/ai-response-worker.ts, workers/ai-handoff-from-sentiment.handler.ts,
 *      lib/mcp/tools/handoff.ts). Aplica `handoff_policy` do pointer aos
 *      enrollments vivos do contato (resolvido via `payload.conversation_id`
 *      → `conversations.contact_id`, payload não tem contact_id).
 *   3. `ai.handoff_resolved` (handoff fechado) — NOVO. Não existia nenhum
 *      evento de fechamento no repo (grep confirmou — só `ai.reactivated_by_agent`
 *      no audit log, sem event_log). Adicionado em
 *      `app/api/v1/conversations/[id]/reactivate-bot/route.ts` (rota
 *      home-grown, não código portado do WAHA — mesmo padrão `emit_event` já
 *      usado em ~30 rotas deste repo). Resume `paused_handoff` → `active` com
 *      grace de 30min (RESUME_GRACE_MS).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { inboundEhDestaPergunta } from "@/lib/followup/aplicar-inbound";
import type { EnrollmentPatch } from "./engine";
import { triggerConfigSchema } from "./api-schemas";
import type { EnrollmentOutcome, EnrollmentStatus } from "./node-handlers";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";

/** Grace pós-resume (spec §4: "grace configurável, default 30min, knob"). */
export const RESUME_GRACE_MS = 30 * 60_000;

/**
 * Os status que REAGEM AO INBOUND. `dormente` está fora, e é isso que faz a
 * espera longa imune existir sem custo nenhum aqui: a inscrição adormecida não é
 * carregada, então `cancel_on_reply` não a cancela e `acordarPorInbound` não
 * corta o timer dela — sem uma query a mais por mensagem recebida e sem esta
 * camada precisar ler o grafo para saber que o nó era imune.
 *
 * ⚠️ NÃO é a mesma lista de "vivo" da FILA (`QueueTab`/`queue/route.ts`), que
 * INCLUI o dormente de propósito: 28 dias de gente invisível seria uma ilha.
 * Duas listas parecidas com significados diferentes; o nome daqui diz qual é.
 */
export const LIVE_STATUSES: readonly EnrollmentStatus[] = ["active", "waiting_reply", "paused_handoff"];

/**
 * O opt-out alcança o dormente também.
 *
 * STOP e LGPD são hard stop: não admitem exceção de status, e uma espera de 28
 * dias que sobrevivesse ao "pare de me mandar mensagem" voltaria a falar com
 * quem pediu silêncio — um mês depois, quando ninguém mais lembra por quê.
 */
const STATUS_ALCANCADOS_PELO_OPT_OUT: readonly EnrollmentStatus[] = [...LIVE_STATUSES, "dormente", "coletando"];

export interface LiveEnrollmentRef {
  id: string;
  status: EnrollmentStatus;
  current_node_id: string;
  steps_taken: number;
  pointer_id: string;
  handoff_policy: "pause" | "cancel" | "allow";
  /** jsonb bruto do pointer — parseado defensivamente aqui (safeParse, default false). */
  trigger_config: unknown;
  /** Instante em que o nó estacionou. Sem isto o inbound de uma pergunta
   *  anterior acorda a espera seguinte (ALWAYS → menu de novo). */
  updated_at?: string;
}

/** Interface estreita de DB (mesma doutrina de `AdminClient`/`TurnBridgeAdminClient`
 *  — reactivity não usa claim/loadFlowGraph/loadLeadFacts/insertDeadInboxItem, então
 *  não estende `AdminClient` do engine; só o que este consumidor precisa. */
export interface ReactivityAdminClient {
  loadConversationContactId(orgId: string, conversationId: string): Promise<string | null>;
  loadContactBlocked(orgId: string, contactId: string): Promise<boolean>;
  /**
   * `statuses` existe só para o ramo de opt-out, que precisa alcançar o
   * `dormente`. As demais reações usam o default e seguem sem enxergá-lo — em
   * especial o handoff, que se pausasse um dormente o devolveria com a graça de
   * 30 min e acordaria a espera de 28 dias quase um mês cedo.
   */
  loadLiveEnrollmentsForContact(
    orgId: string,
    contactId: string,
    statuses?: readonly EnrollmentStatus[],
  ): Promise<LiveEnrollmentRef[]>;
  insertEnrollmentEvent(event: {
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<{ inserted: boolean }>;
  updateEnrollment(id: string, orgId: string, patch: EnrollmentPatch): Promise<void>;
  /**
   * O relógio do BANCO (`fn_agora()`, migration 0147).
   *
   * ⚠️ NÃO É PRECIOSISMO. Quem acorda um enrollment grava `next_eval_at` e o
   * claim compara com `now()` do Postgres — e o relógio do processo fica
   * 17–34 ms À FRENTE do banco. Gravar o "agora" do processo produz um instante
   * que ainda é FUTURO para o claim: o tick seguinte pula, e o follow-up só
   * reage no tick DEPOIS — até 60 s de silêncio DEPOIS QUE O LEAD RESPONDEU,
   * num sistema cujo propósito é não deixar ninguém esperando.
   *
   * `default now()` não serve aqui: isto é UPDATE, e default só age em INSERT.
   * E o `supabase-js` grava VALOR, nunca EXPRESSÃO — `set next_eval_at = now()`
   * não é exprimível pelo client. Daí a leitura explícita.
   */
  agoraNoBanco(): Promise<string>;
}

export interface ReactivitySummary {
  matched: boolean;
  reacted: number;
}

function parseCancelOnReply(raw: unknown): boolean {
  const parsed = triggerConfigSchema.safeParse(raw);
  if (!parsed.success) return false;
  return parsed.data.cancel_on_reply ?? false;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** Grava o evento de auditoria (idempotente por `idempotencyKey`) e — só se
 *  for a 1ª aplicação — o patch do enrollment. Reaplicar o MESMO patch em
 *  replay é inofensivo (valores fixos), mas pular o insert já barra o caso que
 *  importa: nunca reagir duas vezes ao mesmo evento (ex.: reenfileirar o wake
 *  marker 2x). Mesma doutrina do `applyResult` em engine.ts. */
async function applyStep(
  db: ReactivityAdminClient,
  orgId: string,
  enrollment: Pick<LiveEnrollmentRef, "id" | "current_node_id">,
  idempotencyKey: string,
  eventType: string,
  eventPayload: Record<string, unknown>,
  patch: EnrollmentPatch,
): Promise<boolean> {
  const { inserted } = await db.insertEnrollmentEvent({
    organization_id: orgId,
    enrollment_id: enrollment.id,
    node_id: enrollment.current_node_id,
    event_type: eventType,
    payload: eventPayload,
    idempotency_key: idempotencyKey,
  });
  if (!inserted) return false; // já aplicado nesta ocupação — no-op
  await db.updateEnrollment(enrollment.id, orgId, patch);
  return true;
}

function cancelPatch(clock: () => Date, outcome: EnrollmentOutcome, cancelReason: string): EnrollmentPatch {
  return {
    status: "cancelled",
    outcome,
    cancel_reason: cancelReason,
    next_eval_at: null,
    claimed_until: null,
    completed_at: clock().toISOString(),
    updated_at: clock().toISOString(),
  };
}

async function cancelAll(
  db: ReactivityAdminClient,
  orgId: string,
  eventLogRowId: string,
  enrollments: LiveEnrollmentRef[],
  outcome: EnrollmentOutcome,
  cancelReason: string,
  eventType: string,
  clock: () => Date,
): Promise<number> {
  let reacted = 0;
  for (const e of enrollments) {
    const key = `reactivity:${eventLogRowId}:${e.id}:${eventType}`;
    const applied = await applyStep(db, orgId, e, key, eventType, { reason: cancelReason }, cancelPatch(clock, outcome, cancelReason));
    if (applied) reacted++;
  }
  return reacted;
}

// ---- reação 1: message.received (inbound) ---------------------------------

async function reactToInbound(
  db: ReactivityAdminClient,
  clock: () => Date,
  row: EventRow,
): Promise<ReactivitySummary> {
  const contactId = strOrNull(row.payload.contact_id);
  if (!contactId) return { matched: false, reacted: 0 };

  const isBlocked = await db.loadContactBlocked(row.organization_id, contactId);
  // Carrega JÁ com o dormente: o ramo de opt-out abaixo precisa alcançá-lo, e
  // uma segunda consulta só para o caso bloqueado pagaria uma ida ao banco em
  // toda mensagem recebida da instalação para servir a minoria.
  const live = await db.loadLiveEnrollmentsForContact(
    row.organization_id,
    contactId,
    STATUS_ALCANCADOS_PELO_OPT_OUT,
  );

  if (isBlocked) {
    // STOP/opt-out (a regex já rodou em lib/waha/ingest.ts e setou is_blocked
    // ANTES de emitir este evento, na mesma request — ver header do arquivo).
    // Hard stop LGPD/anti-ban: cancela TUDO que está vivo, sem exceção de política.
    const reacted = await cancelAll(db, row.organization_id, row.id, live, "opted_out", "stop_keyword", "reactivity_opted_out", clock);
    return { matched: true, reacted };
  }

  // Daqui para baixo o dormente sai de cena: os dois filtros abaixo pegam
  // `waiting_reply` e `active`, e ele não é nenhum dos dois. É assim que a
  // espera imune sobrevive — não por um `if` de imunidade, mas por não estar
  // no conjunto que reage.
  const waitingReply = live.filter((e) => e.status === "waiting_reply");
  const esperaAtiva = live.filter((e) => e.status === "active");
  let reacted = 0;
  for (const e of waitingReply) {
    if (parseCancelOnReply(e.trigger_config)) {
      const key = `reactivity:${row.id}:${e.id}:reactivity_replied`;
      const applied = await applyStep(
        db,
        row.organization_id,
        e,
        key,
        "reactivity_replied",
        { reason: "cancel_on_reply" },
        cancelPatch(clock, "replied", "cancel_on_reply"),
      );
      if (applied) reacted++;
      continue;
    }

    if (await acordarPorInbound(db, clock, row, e)) reacted++;
  }
  // Uma espera por tempo fixo fica `active` com timer. Quando o fluxo declara
  // `cancel_on_reply`, a resposta deve encerrar também esta ocupação — não
  // acordar o próximo nó e disparar a próxima mensagem imediatamente. Sem a
  // verificação abaixo, a opção funcionava apenas para nós `waiting_reply`.
  for (const e of esperaAtiva) {
    if (parseCancelOnReply(e.trigger_config)) {
      const key = `reactivity:${row.id}:${e.id}:reactivity_replied`;
      const applied = await applyStep(
        db,
        row.organization_id,
        e,
        key,
        "reactivity_replied",
        { reason: "cancel_on_reply" },
        cancelPatch(clock, "replied", "cancel_on_reply"),
      );
      if (applied) reacted++;
      continue;
    }

    if (await acordarPorInbound(db, clock, row, e)) reacted++;
  }
  return { matched: true, reacted };
}

async function acordarPorInbound(
  db: ReactivityAdminClient,
  _clock: () => Date,
  row: EventRow,
  e: LiveEnrollmentRef,
): Promise<boolean> {
  // A mensagem que acabou de avançar o nó (e estacionou uma espera NOVA)
  // não acorda essa espera. Sem `created_at`/`sent_at` falha aberto: o
  // kick sintético ainda precisa acordar a espera que já existia.
  const enviadaEm = strOrNull(row.payload.sent_at) ?? row.created_at ?? null;
  if (enviadaEm && e.updated_at && !inboundEhDestaPergunta(enviadaEm, e.updated_at)) {
    return false;
  }
  const wakeKey = `${e.current_node_id}:${e.steps_taken}:wake`;
  const agora = await db.agoraNoBanco();
  return applyStep(
    db,
    row.organization_id,
    e,
    wakeKey,
    "inbound_woke",
    {},
    // Não toca `updated_at`: o piso do inbound da pergunta é o instante em que
    // o nó estacionou. Regravar agora faria a mensagem que acordou a espera
    // parecer anterior à pergunta (`enviadaEm >= updated_at` falha).
    { next_eval_at: agora },
  );
}

// ---- reação 2: ai.handoff_triggered (aberto) -------------------------------

/**
 * Escopo deliberadamente por CONTATO, não por conversa: `LiveEnrollmentRef`
 * não carrega `conversation_id` (um contato pode ter enrollments vivos sem
 * conversa associada — gatilho manual/silêncio) e um handoff numa conversa
 * pausa TODOS os fluxos vivos do contato, não só um vinculado àquela
 * conversa específica — o humano está atendendo a PESSOA, não um canal.
 */
async function reactToHandoffOpen(
  db: ReactivityAdminClient,
  clock: () => Date,
  row: EventRow,
): Promise<ReactivitySummary> {
  const conversationId = strOrNull(row.payload.conversation_id);
  if (!conversationId) return { matched: false, reacted: 0 };

  const contactId =
    strOrNull(row.payload.contact_id) ?? (await db.loadConversationContactId(row.organization_id, conversationId));
  if (!contactId) return { matched: true, reacted: 0 };

  const live = await db.loadLiveEnrollmentsForContact(row.organization_id, contactId);
  let reacted = 0;
  for (const e of live) {
    if (e.handoff_policy === "allow") continue;

    if (e.handoff_policy === "cancel") {
      const key = `reactivity:${row.id}:${e.id}:reactivity_handoff_cancel`;
      const applied = await applyStep(
        db,
        row.organization_id,
        e,
        key,
        "reactivity_handoff_cancel",
        { reason: "handoff_triggered" },
        cancelPatch(clock, "handoff", "handoff_triggered"),
      );
      if (applied) reacted++;
      continue;
    }

    // 'pause' — anti-Tomik: paused_handoff SÓ existe com este consumidor
    // (ai.handoff_resolved, reactToHandoffClose abaixo) capaz de retomar.
    const key = `reactivity:${row.id}:${e.id}:handoff_paused`;
    const applied = await applyStep(
      db,
      row.organization_id,
      e,
      key,
      "handoff_paused",
      { prior_status: e.status },
      { status: "paused_handoff", next_eval_at: null, claimed_until: null, updated_at: clock().toISOString() },
    );
    if (applied) reacted++;
  }
  return { matched: true, reacted };
}

// ---- reação 3: ai.handoff_resolved (fechado) -------------------------------

/** Mesmo escopo por CONTATO da reactToHandoffOpen acima (não por conversa) —
 *  retoma TODOS os `paused_handoff` do contato, simétrico à pausa. */
async function reactToHandoffClose(
  db: ReactivityAdminClient,
  clock: () => Date,
  row: EventRow,
): Promise<ReactivitySummary> {
  const conversationId = strOrNull(row.payload.conversation_id);
  const contactId =
    strOrNull(row.payload.contact_id) ??
    (conversationId ? await db.loadConversationContactId(row.organization_id, conversationId) : null);
  if (!contactId) return { matched: false, reacted: 0 };

  const live = await db.loadLiveEnrollmentsForContact(row.organization_id, contactId);
  const paused = live.filter((e) => e.status === "paused_handoff");
  let reacted = 0;
  for (const e of paused) {
    const key = `reactivity:${row.id}:${e.id}:handoff_resumed`;
    const nextEvalAt = new Date(clock().getTime() + RESUME_GRACE_MS).toISOString();
    const applied = await applyStep(
      db,
      row.organization_id,
      e,
      key,
      "handoff_resumed",
      {},
      { status: "active", next_eval_at: nextEvalAt, claimed_until: null, updated_at: clock().toISOString() },
    );
    if (applied) reacted++;
  }
  return { matched: true, reacted };
}

/**
 * Dispatch por `event_type` — chamado por `reactivity.handler.ts` (adapter do
 * dispatcher genérico) e diretamente pelos testes DB-real. Tipo desconhecido
 * (não deveria acontecer — `events` do handler já filtra) vira no-op.
 */
export async function applyReactivityEvent(
  db: ReactivityAdminClient,
  clock: () => Date,
  row: EventRow,
): Promise<ReactivitySummary> {
  switch (row.event_type) {
    case "message.received":
      return reactToInbound(db, clock, row);
    case "ai.handoff_triggered":
      return reactToHandoffOpen(db, clock, row);
    case "ai.handoff_resolved":
      return reactToHandoffClose(db, clock, row);
    default:
      return { matched: false, reacted: 0 };
  }
}

// ---------------------------------------------------------------------------
// Adapter de produção: `ReactivityAdminClient` sobre o `SupabaseClient` real
// (service role) — usado por `reactivity.handler.ts` dentro da rota de cron
// `event-log-drain` (Next.js, sempre supabase-js aqui, nunca pg puro — ver
// header do arquivo).
// ---------------------------------------------------------------------------

export function createSupabaseReactivityClient(admin: SupabaseClient): ReactivityAdminClient {
  return {
    async loadConversationContactId(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("contact_id")
        .eq("id", conversationId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.contact_id ?? null;
    },
    async loadContactBlocked(orgId, contactId) {
      const { data, error } = await admin
        .from("contacts")
        .select("is_blocked")
        .eq("id", contactId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.is_blocked ?? false;
    },
    async loadLiveEnrollmentsForContact(orgId, contactId, statuses = LIVE_STATUSES) {
      const ids = await idsDoContatoEGemeos(admin, orgId, contactId);
      const { data: enrollments, error } = await admin
        .from("followup_enrollments")
        .select("id, status, current_node_id, steps_taken, pointer_id, updated_at")
        .eq("organization_id", orgId)
        .in("contact_id", ids)
        .in("status", statuses);
      if (error) throw new Error(error.message);
      if (!enrollments?.length) return [];

      const pointerIds = [...new Set(enrollments.map((e) => e.pointer_id))];
      const { data: pointers, error: pErr } = await admin
        .from("followup_flow_pointers")
        .select("id, handoff_policy, trigger_config")
        .eq("organization_id", orgId)
        .in("id", pointerIds);
      if (pErr) throw new Error(pErr.message);
      const byPointer = new Map((pointers ?? []).map((p) => [p.id, p]));

      return enrollments.map((e) => {
        const p = byPointer.get(e.pointer_id);
        return {
          id: e.id,
          status: e.status as EnrollmentStatus,
          current_node_id: e.current_node_id,
          steps_taken: e.steps_taken,
          pointer_id: e.pointer_id,
          handoff_policy: (p?.handoff_policy as LiveEnrollmentRef["handoff_policy"]) ?? "pause",
          trigger_config: p?.trigger_config ?? null,
          updated_at: typeof e.updated_at === "string" ? e.updated_at : undefined,
        };
      });
    },
    async insertEnrollmentEvent(event) {
      const { error } = await admin.from("followup_enrollment_events").insert(event);
      if (error) {
        if (error.code === "23505") return { inserted: false };
        throw new Error(error.message);
      }
      return { inserted: true };
    },
    async updateEnrollment(id, orgId, patch) {
      const { error } = await admin.from("followup_enrollments").update(patch).eq("id", id).eq("organization_id", orgId);
      if (error) throw new Error(error.message);
    },
    async agoraNoBanco() {
      const { data, error } = await admin.rpc("fn_agora" as never);
      if (error) throw new Error(`fn_agora: ${error.message}`);
      return data as unknown as string;
    },
  };
}
