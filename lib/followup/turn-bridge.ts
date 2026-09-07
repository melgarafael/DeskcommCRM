import type {JobClaim} from "@/lib/agent-engine/queue/claim";
import { assertAgendaEffectPg } from "@/lib/agenda/efeito";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { requireCurrentServiceBoundary } from "@/lib/atendimento/fronteira-server";
import { parseServiceBoundary } from "@/lib/atendimento/fronteira";
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
import { classEdgeMatch, selectEdge, type EnrollmentRow } from "./node-handlers";
import { coletarEsperasAdaptativas, montarTimingPlan, type PropostaDeEspera } from "./timing-plan";
import { persistirRespostaFollowupPg } from "./persistir-resposta";

/** Superset de AdminClient: a ponte precisa do snapshot COMPLETO do enrollment
 *  (current_node_id/version_id/steps_taken) pra montar o passo de conclusão —
 *  algo que AdminClient não tinha (só claim em lote). Extensão isolada aqui
 *  (não no AdminClient do engine) pra não obrigar o adapter pg-puro já
 *  aprovado em tests/invariants/followup-engine.test.ts a ganhar um método
 *  que ele não usa (HANDOFF Decisões — AdminClient é interface própria e
 *  estreita por consumidor). */
export interface TurnBridgeAdminClient extends AdminClient {
  assertFollowupJob?(orgId:string,jobId:string,enrollmentId:string,nodeId:string,claim?:JobClaim):Promise<void>;
  loadEnrollmentById(orgId: string, id: string): Promise<EnrollmentRow | null>;
}

/** Resultado de um turno `followup_turn` dirigido por fluxo, por `purpose`. */
export type TurnResult =
  | { kind: "sent" }
  | { kind: "skipped"; reason: string }
  | { kind: "classified"; class: string }
  /** Plano de tempo do fluxo inteiro, proposto no acionamento — cru, antes do clamp. */
  | { kind: "planned"; propostas: PropostaDeEspera[]; modelo: string };

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
  jobId?: string,
  jobClaim?:JobClaim,
): Promise<void> {
  const enrollment = await db.loadEnrollmentById(orgId, enrollmentId);
  if (!enrollment) return; // enrollment sumiu (nunca deveria, mas nada a completar)
  if (enrollment.current_node_id !== nodeId) return; // turno tardio/obsoleto — o enrollment já saiu do nó
  // SÓ QUEM ESTÁ ANDANDO AVANÇA — lista positiva, e isso é o conserto.
  //
  // O guard nasceu excluindo completed/cancelled/dead e a Task 5.2 teve de
  // acrescentar `paused_handoff` depois, porque um turno em voo reativava por
  // baixo do `reactToHandoffClose`. Lista negativa tem esse modo de falha por
  // construção: todo estado NOVO entra por omissão, e o sintoma é silencioso —
  // o resultado stale (computado ANTES de o humano intervir) sobrescreve a
  // decisão da pessoa e o fluxo volta a andar sozinho.
  //
  // Aconteceu de novo com `paused_manual` (migration 0145): sem esta troca, um
  // envio que terminasse depois do clique desfazia a pausa em silêncio.
  // Descartar o resultado é o comportamento CERTO, não perda de dado.
  if (enrollment.status !== "active" && enrollment.status !== "waiting_reply") return;

  if(jobId) await db.assertFollowupJob?.(orgId,jobId,enrollmentId,nodeId,jobClaim);
  await db.assertServiceBoundary?.(enrollment);
  if(result.kind === "planned" || result.kind === "classified") await db.assertAgenda?.(enrollment);
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
    await db.assertServiceBoundary?.(enrollment);
    if(result.kind === "planned" || result.kind === "classified") await db.assertAgenda?.(enrollment);
    if(db.applyEnrollmentStep){
      await db.applyEnrollmentStep(enrollmentId,orgId,{...patch,steps_taken:enrollment.steps_taken+1,claimed_until:null,updated_at:now.toISOString()},
        {...(jobId?{job_id:jobId,job_claim:jobClaim}:{}),node_id:node.id,event_type:eventType,payload,idempotency_key:idemKey});
      return;
    }
    const { inserted } = await db.insertEnrollmentEvent({
      organization_id: orgId,
      enrollment_id: enrollmentId,
      node_id: node.id,
      event_type: eventType,
      payload,
      idempotency_key: idemKey,
    });
    if (!inserted) return; // replay — a 1ª aplicação já progrediu o enrollment
    await db.assertServiceBoundary?.(enrollment);
    await db.updateEnrollment(enrollmentId, orgId, {
      ...patch,
      steps_taken: enrollment.steps_taken + 1,
      claimed_until: null,
      updated_at: now.toISOString(),
    });
  };

  if(result.kind === "skipped"){
    await applyStep("turn_skipped",{reason:result.reason},{status:"cancelled",cancel_reason:result.reason,completed_at:now.toISOString(),next_eval_at:null});
    return;
  }

  if (result.kind === "sent") {
    // match_reply (if_exists: confirm) enfileira a pergunta e permanece no nó.
    // Completar o envio não avança — a resposta do lead é que avança.
    // Lançar aqui devolvia o job pra pending e o pipeline mandava a pergunta de novo.
    if (node.type === "match_reply") return;
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
    const edge = selectEdge(graph.edges, node.id, classEdgeMatch(node, result.class));
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

  // 'planned' — o acionamento decidiu os instantes de TODAS as esperas adaptativas.
  if (node.type !== "trigger") {
    throw new Error(`completeTurnForEnrollment: resultado 'planned' mas o nó "${node.id}" não é 'trigger'`);
  }
  // Clampa contra o GRAFO PINADO, nunca contra o que o payload do modelo afirma
  // que o intervalo era: quem propõe é a IA, quem decide o intervalo é o nó.
  const plano = montarTimingPlan({
    esperas: coletarEsperasAdaptativas(graph.nodes),
    propostas: result.propostas,
    modelo: result.modelo,
    agora: now,
  });
  const edge = selectEdge(graph.edges, node.id, { type: "always" });
  if (!edge) throw new Error(`trigger node "${node.id}" sem aresta 'always' de saída`);
  await applyStep(
    "timing_plan_decidido",
    // O plano inteiro no evento (não só um ponteiro pra coluna): a timeline do
    // enrollment precisa ser legível sozinha, com o motivo de cada espera.
    { ...plano },
    {
      current_node_id: edge.target,
      status: "active",
      next_eval_at: now.toISOString(),
      timing_plan: plano,
    },
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
    service_boundary: parseServiceBoundary(row.service_boundary),
    revision:Number(row.revision),
    appointment_id:row.appointment_id as string|null,
    appointment_revision:row.appointment_revision as number|null,
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
    // `?? null` e não `as TimingPlan`: num clone sem a migration 0144 a chave
    // simplesmente não vem, e "sem plano" é exatamente o que null significa.
    timing_plan: row.timing_plan ?? null,
  };
}

/** `TurnBridgeAdminClient` sobre `pg.Pool` — produção do worker 24/7. */
export function createPgAdminClient(pool: pg.Pool): TurnBridgeAdminClient {
  const revisions=new Map<string,number>();
  return {
    async assertFollowupJob(orgId,jobId,enrollmentId,nodeId,claim){
      if(!claim)throw new StaleServiceBoundaryError();
      const held=await pool.query("select fn_followup_claim_current($1,$2,$3,$4) current",[orgId,jobId,claim.worker_id,claim.acquired_at]);
      if(!held.rows[0]?.current)throw new StaleServiceBoundaryError();
      const {rows}=await pool.query("select fn_followup_job_current($1,$2,$3,$4) current",[orgId,jobId,enrollmentId,nodeId]);
      if(!rows[0]?.current) throw new StaleServiceBoundaryError();
    },
    async assertServiceBoundary(enrollment) { if(!revisions.has(enrollment.id)&&enrollment.revision!==undefined) revisions.set(enrollment.id,enrollment.revision); await requireCurrentServiceBoundary(pool, enrollment.service_boundary ?? null); },
    async assertAgenda(enrollment){await assertAgendaEffectPg(pool,{organizationId:enrollment.organization_id,contactId:enrollment.contact_id,enrollmentId:enrollment.id,nodeId:enrollment.current_node_id});},
    async claimDueEnrollments(limit, leaseSeconds) {
      const { rows } = await pool.query(`select * from fn_claim_due_followup_enrollments($1, $2)`, [
        limit,
        leaseSeconds,
      ]);
      for(const row of rows) revisions.set(row.id,Number(row.revision));
      return rows.map(mapEnrollmentRow);
    },
    async loadEnrollmentById(orgId, id) {
      const { rows } = await pool.query(
        `select * from followup_enrollments where id = $1 and organization_id = $2`,
        [id, orgId],
      );
      if(rows[0]) revisions.set(id,Number(rows[0].revision));
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
      const { rows: leads } = await pool.query<{
        stage_id: string | null;
        tags: string[];
        custom_fields: Record<string, unknown> | null;
      }>(
        `select stage_id, tags, custom_fields from crm_leads where organization_id = $1 and contact_id = $2
         order by updated_at desc limit 1`,
        [orgId, contactId],
      );
      const { rows: contacts } = await pool.query<{ name: string | null }>(
        `select name from contacts where organization_id = $1 and id = $2`,
        [orgId, contactId],
      );
      const lead = leads[0];
      return {
        lead_stage: lead?.stage_id ?? null,
        tags: lead?.tags ?? [],
        contact_name: contacts[0]?.name ?? null,
        custom_fields: lead?.custom_fields ?? {},
      };
    },
    async loadLastInboundBody(orgId, contactId, conversationId, naoAntesDe) {
      const params: unknown[] = [orgId, contactId, conversationId ?? null];
      const desde = naoAntesDe ? "and sent_at >= $4" : "";
      if (naoAntesDe) params.push(naoAntesDe);
      const { rows } = await pool.query<{ body: string | null }>(
        `select body from messages
         where organization_id = $1 and contact_id = $2 and ($3::uuid is null or conversation_id=$3) and direction = 'inbound' ${desde}
         order by sent_at desc limit 1`,
        params,
      );
      const body = rows[0]?.body;
      return typeof body === "string" ? body : null;
    },
    async loadEnrollmentEvents(enrollmentId) {
      const { rows } = await pool.query(
        `select node_id, idempotency_key, event_type, payload from followup_enrollment_events where enrollment_id = $1 order by created_at asc`,
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
    async applyEnrollmentStep(id,orgId,patch,event){
      const revision=revisions.get(id);if(revision===undefined) throw new StaleServiceBoundaryError();
      try{const {rows}=await pool.query("select fn_followup_apply_step($1,$2,$3,$4,$5) revision",[orgId,id,revision,patch,event]);revisions.set(id,Number(rows[0].revision));}
      catch(error){if((error as {code?:string}).code==="23505") return;if((error as {code?:string}).code==="40001") throw new StaleServiceBoundaryError();throw error;}
    },
    async updateEnrollment(id, orgId, patch) {
      const revision=revisions.get(id);
      if(revision===undefined) throw new StaleServiceBoundaryError();
      try {
        const {rows}=await pool.query<{revision:number}>("select fn_followup_patch($1,$2,$3,$4) as revision",[orgId,id,revision,patch]);
        revisions.set(id,Number(rows[0]!.revision));
      } catch(error){if((error as {code?:string}).code==="40001") throw new StaleServiceBoundaryError();throw error;}

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
    async persistirRespostaFollowup(input) {
      await persistirRespostaFollowupPg((sql, params) => pool.query(sql, params), input);
    },
  };
}
