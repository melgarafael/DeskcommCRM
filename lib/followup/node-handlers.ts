/**
 * Node handlers for the follow-up flow engine (Task 4.1) — PURE, no DB access.
 * `engine.ts` owns the tick/DB orchestration; this file only decides "given
 * this node + these facts, what happens next" so it's testable without Postgres.
 */
import { NO_REPLY_BRANCH_ID, nodeBranches } from "./graph-schema";
import type { FlowEdge, FlowNode } from "./graph-schema";
import { clampEspera, esperaPlanejadaDe, type EsperaAdaptativa } from "./timing-plan";

export type EnrollmentStatus =
  | "active"
  | "waiting_reply"
  | "paused_handoff"
  | "completed"
  | "cancelled"
  | "dead";

export type EnrollmentOutcome = "converted" | "replied" | "exhausted" | "opted_out" | "handoff";

/**
 * Snapshot of a `followup_enrollments` row — plain data (not tied to any DB
 * client) so both the pg-backed test adapter and a future supabase-js adapter
 * can produce it. Field names mirror the table (migration 0054) 1:1.
 */
export interface EnrollmentRow {
  id: string;
  organization_id: string;
  pointer_id: string;
  version_id: string;
  contact_id: string;
  conversation_id: string | null;
  current_node_id: string;
  status: EnrollmentStatus;
  next_eval_at: string | null;
  claimed_until: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  steps_taken: number;
  outcome: EnrollmentOutcome | null;
  cancel_reason: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  /**
   * Plano de tempo decidido no acionamento (migration 0144) — `unknown` porque
   * é `jsonb` e um clone pode ter qualquer coisa lá; quem lê é
   * `esperaPlanejadaDe` (timing-plan.ts), que degrada em vez de lançar.
   * Ausente/`null` = enrollment de antes da feature ⇒ comportamento anterior.
   */
  timing_plan?: unknown;
}

/** Minimal typed facts a `condition` node can check — loaded by the engine, never guessed. */
export interface LeadFacts {
  lead_stage: string | null;
  tags: string[];
  steps_taken: number;
  last_outcome: string | null;
}

/** Reference to a `followup_enrollment_events` row — only what `resolveWaitPhase` needs. */
export interface EnrollmentEventRef {
  node_id: string | null;
  idempotency_key: string | null;
}

export type NodeResult =
  // `reason` só aparece quando o avanço NÃO é o avanço comum: hoje, o trigger
  // desistindo do plano de tempo (o turno nunca voltou). Vira event_type próprio
  // no engine — seguir sem plano é um fato que o operador precisa poder ler.
  | { kind: "advance"; next_node_id: string; next_eval_at: Date; reason?: "plan_timeout" }
  | { kind: "wait"; next_eval_at: Date } // stays on the node
  | {
      kind: "enqueue_turn";
      purpose: "send_message" | "classify" | "plan_timing";
      wake_status: "active" | "waiting_reply";
    }
  // action recheck: the send turn is already in flight; stay put WITHOUT re-enqueuing (anti-dup-send).
  | { kind: "recheck"; next_eval_at: Date }
  // action dead-man: the turn never completed after MAX_ACTION_RECHECKS — give up (engine routes to markDead).
  | { kind: "dead"; reason: string }
  // outcome is nullable for the 'custom' end-node case (cancel_reason carries the note instead).
  | { kind: "complete"; outcome: EnrollmentOutcome | null; cancel_reason?: string }
  | { kind: "fail"; error: string };

/** Backoff ladder indexed by `attempts - 1` (clamped to the last slot) — 30s..1h. */
export const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;

/** Recheck cadence while an action's send turn is in flight — how long the engine waits before
 *  looking again to see if the turn landed. Imported by engine.ts for the enqueue next_eval_at too. */
export const ACTION_RECHECK_MS = 5 * 60_000;

/** Teto do backoff entre rechecks — a partir daqui a espera não cresce mais. */
export const ACTION_RECHECK_MAX_MS = 60 * 60_000;

/**
 * Dead-man bound: idle rechecks tolerated on an action node before a turn that never completes
 * (worker down / permanently failing) is markDead — never re-enqueues, never waits forever.
 *
 * ⚠️ ERA 5, E 5 × 5min MATAVA TODO FOLLOW-UP DA NOITE. A espera do envio tem um
 * motivo LEGÍTIMO e longo que este contador não distinguia de "worker morto": a
 * janela anti-ban (7h–22h no padrão). Um toque que caísse às 22h ficava ~25 min
 * em recheck e o enrollment morria com `action_turn_never_completed` — o lead
 * nunca recebia, e o motivo registrado era falso. Medido em produção
 * (2026-08-18): enrollment `dead` no nó de abertura, com o worker vivo e o turno
 * apenas esperando a janela.
 *
 * Com o backoff de `atrasoDoRecheck`, este orçamento cobre ~11h — mais que a
 * maior noite fechada — e ainda custa poucos ticks. O dead-man continua
 * existindo: worker realmente morto termina em `dead`, só que depois de uma
 * espera que não confunde noite com defeito.
 */
export const MAX_ACTION_RECHECKS = 14;

/**
 * Quanto esperar até o próximo recheck da ação: 5min dobrando até 1h.
 *
 * Exponencial e não fixo porque as duas causas de espera têm escalas
 * diferentes: turno em voo volta em segundos (os primeiros rechecks são
 * curtos), janela fechada volta em horas (e aí não faz sentido perguntar de 5
 * em 5 minutos por 9 horas).
 */
export function atrasoDoRecheck(rechecksJaFeitos: number): number {
  const passo = Math.max(0, rechecksJaFeitos);
  return Math.min(ACTION_RECHECK_MS * 2 ** passo, ACTION_RECHECK_MAX_MS);
}

/**
 * Dead-man do PLANO de tempo: rechecks tolerados no `trigger` esperando o turno
 * de planejamento voltar. Menor que o da ação (3 × 5min ≈ 15min) e com desfecho
 * OPOSTO — aqui o fluxo SEGUE sem plano, nunca morre. Um planejador de tempo
 * indisponível não pode matar o follow-up: sem ele o fluxo ainda funciona
 * inteiro (cai no máximo de cada espera, que é o comportamento anterior);
 * matar o enrollment trocaria uma degradação por uma perda.
 */
export const MAX_PLAN_RECHECKS = 3;

export type EdgeMatch =
  | { type: "always" }
  | { type: "class_match"; value: string }
  | { type: "cond_result"; value: boolean }
  | { type: "branch"; branch_id: string };

/**
 * Qual saída de um nó de classificação leva à classe `classe` — resolvendo os
 * dois dialetos (nó v1 casa por texto, nó migrado casa pelo id estável do ramo).
 *
 * Existe como função porque a MESMA pergunta é feita em dois pontos do caminho
 * de execução: aqui, quando o prazo vence sem resposta, e no `turn-bridge`,
 * quando o modelo classifica. Consertar só um dos dois deixava o fluxo migrado
 * roteando certo para quem responde e errado, em silêncio, para quem não
 * responde — que num follow-up é o caso mais comum. Achado pelo DevVivo na
 * revisão: eu tinha ensinado o `selectEdge` a casar ramo e usado isso só no
 * `condition`.
 *
 * Casa por rótulo E por id de propósito: `no_reply` é reservado (id `no_reply`,
 * rótulo "Sem resposta"), e uma classe do usuário é achada pelo texto que ele
 * escreveu.
 */
export function classEdgeMatch(
  node: Extract<FlowNode, { type: "ai_classify" }>,
  classe: string,
): EdgeMatch {
  const ramo = nodeBranches(node).find(
    (b) => b.kind === "match" && (b.label === classe || b.id === classe),
  );
  return ramo?.condition.type === "branch"
    ? { type: "branch", branch_id: ramo.condition.branch_id }
    : { type: "class_match", value: classe };
}

/**
 * Picks the outbound edge from `from`: highest `priority` first, exact
 * condition match tried first, `always` as fallback. `null` if nothing fits.
 */
export function selectEdge(edges: FlowEdge[], from: string, match: EdgeMatch): FlowEdge | null {
  const candidates = edges.filter((e) => e.source === from).slice().sort((a, b) => b.priority - a.priority);

  const exact = candidates.find((e) => {
    switch (match.type) {
      case "always":
        return e.condition.type === "always";
      case "class_match":
        return e.condition.type === "class_match" && e.condition.value === match.value;
      case "cond_result":
        return e.condition.type === "cond_result" && e.condition.value === match.value;
      case "branch":
        return e.condition.type === "branch" && e.condition.branch_id === match.branch_id;
    }
  });
  if (exact) return exact;

  if (match.type !== "always") {
    const fallback = candidates.find((e) => e.condition.type === "always");
    if (fallback) return fallback;
  }
  return null;
}

/**
 * A `wait` node is entered twice: once to start the timer (writes the
 * generic step event), once after `next_eval_at` elapses to advance. Both
 * ticks see the SAME node (current_node_id unchanged) with `steps_taken`
 * incrementing by exactly 1 on every applied step (engine.ts) — so "did we
 * already start this wait" is exactly "does the event for the PRIOR step on
 * this node exist".
 */
export function resolveWaitPhase(events: EnrollmentEventRef[], nodeId: string, stepsTaken: number): boolean {
  const priorKey = `${nodeId}:${stepsTaken - 1}`;
  return events.some((e) => e.node_id === nodeId && e.idempotency_key === priorKey);
}

function evaluateCheck(
  check: { field: "lead_stage" | "tag" | "steps_taken" | "last_outcome"; op: "eq" | "neq" | "gte" | "lte" | "contains"; value: string | number },
  lead: LeadFacts,
): boolean {
  const actual: string | number | null | string[] =
    check.field === "lead_stage" ? lead.lead_stage
    : check.field === "tag" ? lead.tags
    : check.field === "steps_taken" ? lead.steps_taken
    : lead.last_outcome;

  if (Array.isArray(actual)) {
    // 'tag' é multi-valorado: eq/contains viram "está entre as tags"; gte/lte não fazem sentido.
    const included = actual.includes(String(check.value));
    if (check.op === "eq" || check.op === "contains") return included;
    if (check.op === "neq") return !included;
    return false;
  }

  switch (check.op) {
    case "eq":
      return actual === check.value;
    case "neq":
      return actual !== check.value;
    case "gte":
      return typeof actual === "number" && typeof check.value === "number" && actual >= check.value;
    case "lte":
      return typeof actual === "number" && typeof check.value === "number" && actual <= check.value;
    case "contains":
      return typeof actual === "string" && typeof check.value === "string" && actual.includes(check.value);
  }
}

function evaluateCondition(
  config: Extract<FlowNode, { type: "condition" }>["config"],
  lead: LeadFacts,
): boolean {
  const results = config.checks.map((check) => evaluateCheck(check, lead));
  return config.combinator === "and" ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Pure per-node decision. `waitElapsed` is resolved by the engine (via
 * `resolveWaitPhase` against real events) BEFORE calling this — optional so
 * non-`wait`/`ai_classify` calls don't need to pass it. For `ai_classify` it
 * means "a classify turn was already enqueued for this occupancy of the node"
 * (same prior-step-event check as `wait`) — re-entering with it `true` means
 * EITHER `grace_timeout_ms` elapsed without a completed classification OR
 * reactivity (Task 5.2, `lib/followup/reactivity.ts`) woke the node early
 * because an inbound reply arrived. `wokeEarly` is the signal that
 * disambiguates the two (own marker event, distinct from the
 * `classify_enqueued` event `waitElapsed` checks): `true` re-enqueues a fresh
 * classify turn with the real reply instead of auto-advancing via `no_reply`.
 */
export function processNode(input: {
  node: FlowNode;
  edges: FlowEdge[];
  enrollment: EnrollmentRow;
  lead: LeadFacts;
  clock: () => Date;
  waitElapsed?: boolean;
  wokeEarly?: boolean;
  /** action occupancy guard: a `turn_enqueued` event for THIS stay on the action node already
   *  exists (an entry/recheck happened before). Resolved by the engine via `resolveWaitPhase`
   *  — same prior-step-event check as `wait`. When true, the send turn is in flight: DON'T
   *  re-enqueue (a second job_id would bypass the send sink's (job_id,seq) dedup → dup message). */
  actionEnqueued?: boolean;
  /** action dead-man counter: number of events already accumulated on this action node — used to
   *  bound rechecks so a turn that never completes routes to `dead` instead of looping forever. */
  actionRecheckCount?: number;
  /** trigger: as esperas adaptativas do grafo pinado (`coletarEsperasAdaptativas`). Vazio/ausente
   *  ⇒ não há o que planejar e o acionamento NÃO paga uma chamada de modelo. */
  smartWaits?: EsperaAdaptativa[];
  /** trigger occupancy guard: um turno de planejamento para ESTA estadia no trigger já foi
   *  enfileirado. Mesmo check de evento-do-passo-anterior do wait/action (`resolveWaitPhase`). */
  planEnqueued?: boolean;
  /** trigger dead-man counter: eventos já acumulados no nó trigger — limita os rechecks para que
   *  um turno de planejamento que nunca volta siga SEM plano em vez de esperar para sempre. */
  planRecheckCount?: number;
}): NodeResult {
  const {
    node,
    edges,
    enrollment,
    clock,
    lead,
    waitElapsed,
    wokeEarly,
    actionEnqueued,
    actionRecheckCount,
    smartWaits,
    planEnqueued,
    planRecheckCount,
  } = input;

  switch (node.type) {
    case "trigger": {
      const edge = selectEdge(edges, node.id, { type: "always" });
      if (!edge) return { kind: "fail", error: `trigger node "${node.id}" has no outbound edge` };

      // ACIONAMENTO: é aqui que o plano de tempo do fluxo inteiro é decidido, uma
      // única vez, antes do primeiro passo. Fluxo sem espera adaptativa e
      // enrollment que já tem plano seguem direto — nenhum custo de modelo, e o
      // comportamento de antes desta feature fica intacto.
      // `?? null` de propósito: a coluna chega `null` do banco e `undefined` de
      // um snapshot montado antes da migration 0144 — os dois querem dizer "sem
      // plano ainda", e tratar só um deles pularia o planejamento em silêncio.
      const precisaPlanejar = (smartWaits?.length ?? 0) > 0 && (enrollment.timing_plan ?? null) === null;
      if (!precisaPlanejar) {
        return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
      }
      if (!planEnqueued) {
        return { kind: "enqueue_turn", purpose: "plan_timing", wake_status: "active" };
      }
      if ((planRecheckCount ?? 0) >= MAX_PLAN_RECHECKS) {
        // O turno de planejamento nunca voltou. Seguir sem plano (cada espera cai
        // no seu máximo) é a degradação certa — ver MAX_PLAN_RECHECKS.
        return { kind: "advance", next_node_id: edge.target, next_eval_at: clock(), reason: "plan_timeout" };
      }
      return { kind: "recheck", next_eval_at: new Date(clock().getTime() + ACTION_RECHECK_MS) };
    }

    case "wait": {
      if (!waitElapsed) {
        // Adaptativo: o instante vem do plano decidido no acionamento. Sem plano
        // legível para ESTE nó (enrollment anterior à feature, fluxo v1, jsonb
        // corrompido), cai no máximo — que era o comportamento único até aqui.
        //
        // O clamp é REFEITO aqui, contra o nó, mesmo a ponte já tendo clampado ao
        // gravar: "quem decide o intervalo é o nó" só é invariante se valer na
        // LEITURA. `timing_plan` é jsonb num banco que o self-hoster administra —
        // uma linha editada à mão, ou um bug futuro que grave sem clampar,
        // prenderia o lead muito além do que o operador configurou na tela, e
        // ninguém veria. Custa uma comparação por espera.
        const planejada = node.config.mode === "smart" ? esperaPlanejadaDe(enrollment.timing_plan, node.id) : null;
        const durationMs =
          node.config.mode === "fixed"
            ? node.config.duration_ms
            : planejada === null
              ? node.config.max_ms
              : clampEspera(planejada.escolhido_ms, node.config.min_ms, node.config.max_ms).escolhido_ms;
        return { kind: "wait", next_eval_at: new Date(clock().getTime() + durationMs) };
      }
      const edge = selectEdge(edges, node.id, { type: "always" });
      if (!edge) return { kind: "fail", error: `wait node "${node.id}" has no outbound edge after elapsing` };
      return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
    }

    case "condition": {
      if (node.config.branching === "per_check") {
        // "Uma saída por regra": a PRIMEIRA regra que passa manda, e a ordem da
        // lista é a precedência — a mesma ordem que o usuário vê no formulário.
        // Duas regras verdadeiras não podem sortear caminho; `combinator` não
        // é consultado aqui, porque nesse modo a regra não vota, ela roteia.
        const hitId = node.config.checks.find((c) => c.id !== undefined && evaluateCheck(c, lead))?.id;
        // Nenhuma regra passou -> o ramo obrigatório 'else', que na aresta é `always`.
        // `selectEdge` também cai nele quando o usuário deixou um ramo sem ligar:
        // sair pela saída de escape é ruim, ficar preso no nó é pior.
        const edge =
          hitId === undefined
            ? selectEdge(edges, node.id, { type: "always" })
            : selectEdge(edges, node.id, { type: "branch", branch_id: hitId });
        if (!edge) {
          return {
            kind: "fail",
            error: `condition node "${node.id}" has no edge for branch "${hitId ?? "else"}"`,
          };
        }
        return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
      }
      const result = evaluateCondition(node.config, lead);
      const edge = selectEdge(edges, node.id, { type: "cond_result", value: result });
      if (!edge) return { kind: "fail", error: `condition node "${node.id}" has no matching edge for result ${result}` };
      return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
    }

    case "ai_classify": {
      if (!waitElapsed || wokeEarly) {
        // 1ª entrada (waitElapsed=false) OU reactivity acordou cedo com uma
        // resposta real (wokeEarly=true, mesmo com waitElapsed=true — o marker
        // de reactivity é o desempate): reenfileira classify. Nunca conta como
        // 'no_reply' quando existe reply de verdade em voo.
        return { kind: "enqueue_turn", purpose: "classify", wake_status: "waiting_reply" };
      }
      // grace_timeout_ms venceu sem turno de classificação concluído — classifica
      // como 'no_reply' SEM chamar o LLM (onda 5, critério 2); selectEdge já cai
      // no fallback 'always' se não houver aresta 'no_reply' explícita.
      const edge = selectEdge(edges, node.id, classEdgeMatch(node, NO_REPLY_BRANCH_ID));
      if (!edge) return { kind: "fail", error: `ai_classify node "${node.id}" has no edge for class "no_reply" (fallback also missing)` };
      return { kind: "advance", next_node_id: edge.target, next_eval_at: clock() };
    }

    case "action": {
      // At-most-once send: enqueue the turn EXACTLY ONCE per occupancy. First entry
      // (no prior occupancy event) enqueues; a recheck fired while the turn is still in
      // flight — completeTurnForEnrollment (turn-bridge) hasn't advanced the enrollment
      // yet — must NOT re-enqueue. Mirrors the wait/ai_classify guard (resolveWaitPhase),
      // which the action node lacked (steps_taken increments every recheck, so the
      // `${node}:${steps}` idempotency_key was a FRESH key each tick → a 2nd job → a 2nd
      // real send that the send sink's (job_id,seq) dedup can't catch).
      if (!actionEnqueued) {
        return { kind: "enqueue_turn", purpose: "send_message", wake_status: "active" };
      }
      // Dead-man: the turn never completed (worker down / turn permanently failing). Never
      // re-enqueue, never wait forever — after MAX_ACTION_RECHECKS idle rechecks give up.
      // ponytail: recheck budget is counted per-node over the enrollment's lifetime, so a
      // flow that LOOPS back to the same action node shares the budget (re-sending on a
      // loop is itself an anti-ban smell). Precise per-occupancy counting would need the
      // event_type, which EnrollmentEventRef doesn't carry — upgrade there if loops appear.
      if ((actionRecheckCount ?? 0) >= MAX_ACTION_RECHECKS) {
        return { kind: "dead", reason: "action_turn_never_completed" };
      }
      return {
        kind: "recheck",
        next_eval_at: new Date(clock().getTime() + atrasoDoRecheck(actionRecheckCount ?? 0)),
      };
    }

    case "end": {
      if (node.config.outcome === "custom") {
        return { kind: "complete", outcome: null, cancel_reason: node.config.note };
      }
      return { kind: "complete", outcome: node.config.outcome };
    }
  }
}
