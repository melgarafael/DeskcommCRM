/**
 * Ponte engine ⇄ job_queue (Task 5.1, onda 5). Traduz o RESULTADO de um turno
 * `followup_turn` do agent-engine (lib/agent-engine/agent/followup-turn.ts) de
 * volta em progressão de enrollment — o lado followup sabe ler o grafo pinado e
 * escolher a aresta certa; o agent-engine só sabe QUE o turno terminou e chama
 * de volta aqui via callback injetado (a ponte nunca importa nada de
 * agent-engine — a dependência é numa direção só).
 *
 * Espelha o pattern de `engine.ts`: lógica pura (clampProposedAt) + interface
 * estreita de DB (TurnBridgeAdminClient, superset de AdminClient) + adapter de
 * produção (createPgAdminClient — o worker 24/7 fala `pg` puro, não Supabase;
 * ver `createSupabaseAdminClient` em engine.ts pro equivalente REST usado pela
 * rota de cron).
 */
import type pg from "pg";

import type { AdminClient, EnrollmentPatch } from "./engine";
import { flowGraphSchema } from "./graph-schema";
import { selectEdge, type EnrollmentRow } from "./node-handlers";

/** Superset de AdminClient: a ponte precisa do snapshot COMPLETO do enrollment
 *  (current_node_id/version_id/steps_taken) pra montar o passo de conclusão —
 *  algo que AdminClient não tinha (só claim em lote). Extensão isolada aqui
 *  (não no AdminClient do engine) pra não obrigar o adapter pg-puro já
 *  aprovado em tests/invariants/followup-engine.test.ts a ganhar um método
 *  que ele não usa (HANDOFF Decisões — AdminClient é interface própria e
 *  estreita por consumidor). */
export interface TurnBridgeAdminClient extends AdminClient {
  loadEnrollmentById(orgId: string, id: string): Promise<EnrollmentRow | null>;
}

/** Resultado de um turno `followup_turn` dirigido por fluxo, por `purpose`. */
export type TurnResult =
  | { kind: "sent" }
  | { kind: "classified"; class: string }
  | { kind: "timing"; proposed_at: string };

/**
 * Clampa o instante proposto pela IA em `[now+min_ms, now+max_ms]` — `wait`
 * smart nunca deixa a IA decidir fora do range configurado no nó (onda 5,
 * critério 3). `proposed_at` ilegível (parse NaN) degrada pro mínimo — o lado
 * seguro (não deixa o enrollment preso além do combinado por um instante
 * inválido).
 */
export function clampProposedAt(proposedAt: string, now: Date, minMs: number, maxMs: number): Date {
  const parsed = Date.parse(proposedAt);
  const deltaMs = Number.isNaN(parsed) ? minMs : parsed - now.getTime();
  const clampedMs = Math.min(Math.max(deltaMs, minMs), maxMs);
  return new Date(now.getTime() + clampedMs);
}

/**
 * Traduz o resultado de um turno concluído em progressão do enrollment —
 * idempotente por `${node_id}:${steps_taken}` (mesma doutrina de
 * `applyResult` em engine.ts): uma 2ª chamada para o MESMO passo (ex.: job
 * retentado após o ack se perder) bate 23505 no insert do evento e vira no-op,
 * nunca avança/duplica.
 *
 * Desvio deliberado da assinatura esboçada no plano
 * (`completeTurnForEnrollment(db, enrollmentId, result)`): adiciona `orgId`
 * (toda escrita do AdminClient é org-scoped — CLAUDE.md, service role nunca
 * sem filtro manual) e `nodeId` (o node_id que o PAYLOAD do job carregava,
 * não o current_node_id lido agora) — serve de guarda de obsolescência: se o
 * enrollment já saiu desse nó por outro caminho enquanto o turno rodava
 * (ex.: cancelamento), a conclusão tardia vira no-op silencioso em vez de
 * reaplicar sobre o nó errado.
 */
export async function completeTurnForEnrollment(
  db: TurnBridgeAdminClient,
  orgId: string,
  enrollmentId: string,
  nodeId: string,
  result: TurnResult,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const enrollment = await db.loadEnrollmentById(orgId, enrollmentId);
  if (!enrollment) return; // enrollment sumiu (nunca deveria, mas nada a completar)
  if (enrollment.current_node_id !== nodeId) return; // turno tardio/obsoleto — o enrollment já saiu do nó
  // paused_handoff entra aqui: um turno em voo quando o handoff pausou (reactivity.ts)
  // NUNCA pode reativar/avançar por baixo do reactToHandoffClose — o resultado é
  // stale (computado antes do humano intervir); descartar é o comportamento CERTO,
  // não perda de dado (fix de review — Task 5.2, o guard excluía só completed/
  // cancelled/dead, deixando essa corrida passar).
  if (
    enrollment.status === "completed" ||
    enrollment.status === "cancelled" ||
    enrollment.status === "dead" ||
    enrollment.status === "paused_handoff"
  )
    return;

  const graph = await db.loadFlowGraph(orgId, enrollment.version_id);
  if (!graph) throw new Error("flow_version_not_found");
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("node_not_found");

  const now = clock();
  const idemKey = `${node.id}:${enrollment.steps_taken}`;

  const applyStep = async (
    eventType: string,
    payload: Record<string, unknown>,
    patch: EnrollmentPatch,
  ): Promise<void> => {
    const { inserted } = await db.insertEnrollmentEvent({
      organization_id: orgId,
      enrollment_id: enrollmentId,
      node_id: node.id,
      event_type: eventType,
      payload,
      idempotency_key: idemKey,
    });
    if (!inserted) return; // replay — a 1ª aplicação já progrediu o enrollment
    await db.updateEnrollment(enrollmentId, orgId, {
      ...patch,
      steps_taken: enrollment.steps_taken + 1,
      claimed_until: null,
      updated_at: now.toISOString(),
    });
  };

  if (result.kind === "sent") {
    if (node.type !== "action") {
      throw new Error(`completeTurnForEnrollment: resultado 'sent' mas o nó "${node.id}" não é 'action'`);
    }
    const edge = selectEdge(graph.edges, node.id, { type: "always" });
    if (!edge) throw new Error(`action node "${node.id}" sem aresta 'always' de saída`);
    await applyStep(
      "action_sent",
      {},
      { current_node_id: edge.target, status: "active", next_eval_at: now.toISOString() },
    );
    return;
  }

  if (result.kind === "classified") {
    if (node.type !== "ai_classify") {
      throw new Error(`completeTurnForEnrollment: resultado 'classified' mas o nó "${node.id}" não é 'ai_classify'`);
    }
    const edge = selectEdge(graph.edges, node.id, { type: "class_match", value: result.class });
    if (!edge) {
      throw new Error(`ai_classify node "${node.id}" sem aresta pra classe "${result.class}" (fallback 'always' também ausente)`);
    }
    await applyStep(
      "ai_classified",
      { class: result.class },
      { current_node_id: edge.target, status: "active", next_eval_at: now.toISOString() },
    );
    return;
  }

  // 'timing'
  if (node.type !== "wait" || node.config.mode !== "smart") {
    throw new Error(`completeTurnForEnrollment: resultado 'timing' mas o nó "${node.id}" não é 'wait' (smart)`);
  }
  const nextEvalAt = clampProposedAt(result.proposed_at, now, node.config.min_ms, node.config.max_ms);
  await applyStep(
    "wait_started",
    { next_eval_at: nextEvalAt.toISOString(), mode: "smart" },
    { current_node_id: enrollment.current_node_id, status: "active", next_eval_at: nextEvalAt.toISOString() },
  );
}

// ---------------------------------------------------------------------------
// Adapter de produção: TurnBridgeAdminClient falado em `pg` puro — o worker
// 24/7 (workers/agent-worker/main.ts) só tem um pg.Pool, nunca um SupabaseClient
// (esse é o mundo das rotas Next.js, ver createSupabaseAdminClient em
// engine.ts). SQL espelha 1:1 o adapter de teste já provado em
// tests/invariants/followup-engine.test.ts.
// ---------------------------------------------------------------------------

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapEnrollmentRow(row: Record<string, unknown>): EnrollmentRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    pointer_id: row.pointer_id as string,
    version_id: row.version_id as string,
    contact_id: row.contact_id as string,
    conversation_id: (row.conversation_id as string | null) ?? null,
    current_node_id: row.current_node_id as string,
    status: row.status as EnrollmentRow["status"],
    next_eval_at: toIso(row.next_eval_at),
    claimed_until: toIso(row.claimed_until),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    last_error: (row.last_error as string | null) ?? null,
    steps_taken: Number(row.steps_taken),
    outcome: (row.outcome as EnrollmentRow["outcome"]) ?? null,
    cancel_reason: (row.cancel_reason as string | null) ?? null,
    started_at: toIso(row.started_at)!,
    completed_at: toIso(row.completed_at),
    updated_at: toIso(row.updated_at)!,
  };
}

/** `TurnBridgeAdminClient` sobre `pg.Pool` — produção do worker 24/7. */
export function createPgAdminClient(pool: pg.Pool): TurnBridgeAdminClient {
  return {
    async claimDueEnrollments(limit, leaseSeconds) {
      const { rows } = await pool.query(`select * from fn_claim_due_followup_enrollments($1, $2)`, [
        limit,
        leaseSeconds,
      ]);
      return rows.map(mapEnrollmentRow);
    },
    async loadEnrollmentById(orgId, id) {
      const { rows } = await pool.query(
        `select * from followup_enrollments where id = $1 and organization_id = $2`,
        [id, orgId],
      );
      return rows[0] ? mapEnrollmentRow(rows[0] as Record<string, unknown>) : null;
    },
    async loadFlowGraph(orgId, versionId) {
      const { rows } = await pool.query<{ graph: unknown }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return flowGraphSchema.parse(rows[0]!.graph);
    },
    async loadLeadFacts(orgId, contactId) {
      const { rows } = await pool.query<{ stage_id: string | null; tags: string[] }>(
        `select stage_id, tags from crm_leads where organization_id = $1 and contact_id = $2
         order by updated_at desc limit 1`,
        [orgId, contactId],
      );
      if (rows.length === 0) return { lead_stage: null, tags: [] };
      return { lead_stage: rows[0]!.stage_id, tags: rows[0]!.tags };
    },
    async loadEnrollmentEvents(enrollmentId) {
      const { rows } = await pool.query(
        `select node_id, idempotency_key from followup_enrollment_events where enrollment_id = $1`,
        [enrollmentId],
      );
      return rows;
    },
    async insertEnrollmentEvent(event) {
      try {
        await pool.query(
          `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
           values ($1, $2, $3, $4, $5, $6)`,
          [event.organization_id, event.enrollment_id, event.node_id, event.event_type, event.payload, event.idempotency_key],
        );
        return { inserted: true };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false };
        throw err;
      }
    },
    async updateEnrollment(id, orgId, patch) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return;
      const setSql = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
      const values = entries.map(([, v]) => v);
      await pool.query(`update followup_enrollments set ${setSql} where id = $1 and organization_id = $2`, [
        id,
        orgId,
        ...values,
      ]);
    },
    async loadFlowPointerName(orgId, pointerId) {
      const { rows } = await pool.query<{ name: string }>(
        `select name from followup_flow_pointers where organization_id = $1 and id = $2`,
        [orgId, pointerId],
      );
      return rows[0]?.name ?? null;
    },
    async insertDeadInboxItem(item) {
      await pool.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         values ($1, 'followup_dead', 'warn', $2, $3, 'followup_enrollment', $4)`,
        [item.organization_id, item.title, item.body, item.ref_id],
      );
    },
  };
}
