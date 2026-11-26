import { criarOrigemDeFollowup } from "./followup-service-origin";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { descreveEvento, type EventoDeEnrollment } from "@/lib/followup/eventos-legiveis";
import { createApprovedReplyHandler } from "@/lib/agent-engine/agent/approved-reply";
import type { ChannelAdapter } from "@/lib/agent-engine/channel-adapter";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { claimJobs, completeJob, enqueueJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { pgSendLedger, sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";

import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
// O schema do OUTRO lado da fila. Importado só aqui, e só no teste: agent-engine
// nunca importa followup/* (a dependência é numa direção só) — mas provar que as
// duas metades do contrato casam exige ver as duas no mesmo lugar.
import { createFollowupTurnHandler, followupTurnPayloadSchema } from "@/lib/agent-engine/agent/followup-turn";

import { isolarFixtureDeFollowup } from "./followup-isolamento";
import { relogioAncoradoNoBanco } from "./followup-relogio";

/**
 * Task 5.1 — a ponte engine ⇄ job_queue contra Postgres real (baseline
 * aplicado). Reusa o adapter pg-puro de produção (`createPgAdminClient`,
 * lib/followup/turn-bridge.ts) — a MESMA implementação que a wiring real
 * (workers/agent-worker/main.ts) usa, então esta suíte prova o adapter de
 * verdade, não um duplicado de teste.
 *
 * Congela: (1) nó action — engine enfileira → completeTurnForEnrollment
 * conclui → enrollment avança; dupla conclusão (idempotency_key colidindo) é
 * no-op; (2) nó ai_classify — classe bate na aresta exata; classe desconhecida
 * cai no fallback 'always'; (3) grace do ai_classify vence sem turno concluído
 * ⇒ o PRÓPRIO tick do engine roteia 'no_reply' sem reenfileirar (node-handlers
 * fix desta task); (4) wait smart — completeTurnForEnrollment clampa contra o
 * grafo pinado real.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

const db = createPgAdminClient(pool);

// ---- seed helpers (mesmo padrão de tests/invariants/followup-engine.test.ts) ----

async function seedOrg(org: string): Promise<void> {
  const name = `followup-turn-bridge-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContact(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Turn Bridge Contact') returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function seedFlow(org: string, graph: FlowGraph): Promise<{ pointerId: string; versionId: string }> {
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const versionId = versionRows[0]!.id;
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, $2, 'active', $3) returning id`,
    [org, `Turn Bridge Flow ${Date.now()}-${Math.random()}`, versionId],
  );
  return { pointerId: pointerRows[0]!.id, versionId };
}

async function seedEnrollment(params: {
  org: string;
  pointerId: string;
  versionId: string;
  contactId: string;
  currentNodeId: string;
  status?: string;
  stepsTaken?: number;
}): Promise<string> {
  const boundary = await criarOrigemDeFollowup(pool, params.org, params.contactId);
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, steps_taken, conversation_id, service_boundary)
     values ($1, $2, $3, $4, $5, $6, now() - interval '1 second', $7, $8, $9::jsonb)
     returning id`,
    [params.org, params.pointerId, params.versionId, params.contactId, params.currentNodeId, params.status ?? "active", params.stepsTaken ?? 0, boundary.conversation_id, JSON.stringify(boundary)],
  );
  return rows[0]!.id;
}

async function getEnrollment(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(`select * from followup_enrollments where id = $1`, [id]);
  return rows[0]!;
}

function makeTickDeps(jobs: FollowupJobRequest[]): TickDeps {
  return { db, clock: relogioAncoradoNoBanco(), enqueueJob: async (job) => void jobs.push(job) };
}

// ---- graphs ----

const ACTION_GRAPH: FlowGraph = {
  nodes: [
    { id: "a1", type: "action", label: "Send", position: { x: 0, y: 0 }, config: { mode: "ai_message", prompt_hint: "lembre o lead" } },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "a1-e1", source: "a1", target: "e1", priority: 0, condition: { type: "always" } }],
};

const CLASSIFY_GRAPH: FlowGraph = {
  nodes: [
    {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    },
    { id: "hot-node", type: "end", label: "Hot", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    { id: "no-reply-node", type: "end", label: "NoReply", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "ac1-hot", source: "ac1", target: "hot-node", priority: 5, condition: { type: "class_match", value: "hot" } },
    { id: "ac1-noreply", source: "ac1", target: "no-reply-node", priority: 0, condition: { type: "class_match", value: "no_reply" } },
  ],
};

/** Acionamento → espera adaptativa → fim. O grafo do ciclo do plano de tempo. */
const SMART_WAIT_GRAPH: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: "w1",
      type: "wait",
      label: "Wait smart",
      position: { x: 0, y: 0 },
      config: { mode: "smart", min_ms: 600_000, max_ms: 1_800_000, guidance: "não insistir de madrugada" },
    },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "t1-w1", source: "t1", target: "w1", priority: 0, condition: { type: "always" } },
    { id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } },
  ],
};

/** Mesmo fluxo, mas com a espera FIXA: o acionamento não pode pagar planejamento. */
const FIXED_WAIT_GRAPH: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: "w1",
      type: "wait",
      label: "Wait fixo",
      position: { x: 0, y: 0 },
      config: { mode: "fixed", duration_ms: 600_000 },
    },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "t1-w1", source: "t1", target: "w1", priority: 0, condition: { type: "always" } },
    { id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } },
  ],
};

beforeAll(() => {
  flowGraphSchema.parse(ACTION_GRAPH);
  flowGraphSchema.parse(CLASSIFY_GRAPH);
  flowGraphSchema.parse(SMART_WAIT_GRAPH);
  flowGraphSchema.parse(FIXED_WAIT_GRAPH);
});

// Este arquivo compara `tick.scheduled`/`jobs.length` com números exatos e roda
// com `limit: 5`. Sem isolar, o lote pode vir inteiro de enrollments alheios —
// ver ./followup-isolamento.ts para a medição.
beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
});

// ---- 1. action: enqueue → completeTurnForEnrollment → advance; idempotente ----

describe("completeTurnForEnrollment — nó action, ciclo completo", () => {
  it("engine enfileira o turno; completeTurnForEnrollment('sent') avança o enrollment", async () => {
    const org = "bbbbbbb1-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, ACTION_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "a1" });

    const jobs: FollowupJobRequest[] = [];
    const tick = await runFollowupTick(makeTickDeps(jobs), { limit: 5 });
    expect(tick.scheduled).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ followup_enrollment_id: enrollmentId, node_id: "a1", purpose: "send_message", prompt_hint: "lembre o lead" });

    const afterEnqueue = await getEnrollment(enrollmentId);
    expect(afterEnqueue.current_node_id).toBe("a1");
    expect(afterEnqueue.status).toBe("active");

    await completeTurnForEnrollment(db, org, enrollmentId, "a1", { kind: "sent" });

    const afterComplete = await getEnrollment(enrollmentId);
    expect(afterComplete.current_node_id).toBe("e1");
    expect(afterComplete.status).toBe("active");

    const { rows: events } = await pool.query(
      `select event_type, idempotency_key from followup_enrollment_events where enrollment_id = $1 order by created_at`,
      [enrollmentId],
    );
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["turn_enqueued", "action_sent"]);
  });

  it("dupla conclusão do MESMO passo (idempotency_key colidindo) é no-op — não reavança nem duplica evento", async () => {
    const org = "bbbbbbb2-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, ACTION_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "a1" });

    const jobs: FollowupJobRequest[] = [];
    await runFollowupTick(makeTickDeps(jobs), { limit: 5 }); // enqueue: steps_taken 0→1

    // simula outro worker já tendo concluído o MESMO passo (mesma idempotency_key
    // `a1:1` que completeTurnForEnrollment vai tentar gravar) — corrida real entre
    // 2 tentativas do mesmo job.
    await pool.query(
      `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
       values ($1, $2, 'a1', 'action_sent', '{}', 'a1:1')`,
      [org, enrollmentId],
    );

    await completeTurnForEnrollment(db, org, enrollmentId, "a1", { kind: "sent" });

    const after = await getEnrollment(enrollmentId);
    expect(after.current_node_id).toBe("a1"); // não avançou — o insert bateu 23505, update foi pulado
    expect(after.steps_taken).toBe(1);

    const { rows: events } = await pool.query(
      `select count(*) as n from followup_enrollment_events where enrollment_id = $1 and idempotency_key = 'a1:1'`,
      [enrollmentId],
    );
    expect(Number(events[0].n)).toBe(1); // só o evento simulado — completeTurnForEnrollment não duplicou
  });
});

// ---- 2. ai_classify: classe exata + fallback ----

describe("completeTurnForEnrollment — nó ai_classify, classe → aresta", () => {
  it("classe exata roteia pra aresta class_match correspondente", async () => {
    const org = "bbbbbbb3-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, CLASSIFY_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "ac1", stepsTaken: 3 });

    await completeTurnForEnrollment(db, org, enrollmentId, "ac1", { kind: "classified", class: "hot" });

    const after = await getEnrollment(enrollmentId);
    expect(after.current_node_id).toBe("hot-node");
    expect(after.steps_taken).toBe(4);
  });
});

// ---- 3. ai_classify: grace vence sem turno concluído ⇒ engine roteia no_reply ----

describe("runFollowupTick — grace do ai_classify vence sem classificação: no_reply sem reenfileirar", () => {
  it("1º tick enfileira o classify; 2º tick (grace elapsed) avança via 'no_reply' SEM enfileirar de novo", async () => {
    const org = "bbbbbbb4-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, CLASSIFY_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "ac1" });

    const jobs: FollowupJobRequest[] = [];
    const tick1 = await runFollowupTick(makeTickDeps(jobs), { limit: 5 });
    expect(tick1.scheduled).toBe(1);
    expect(jobs).toHaveLength(1);

    const afterTick1 = await getEnrollment(enrollmentId);
    expect(afterTick1.status).toBe("waiting_reply");
    expect(afterTick1.current_node_id).toBe("ac1");

    // simula o grace_timeout_ms elapsindo — nenhum turno de classificação rodou
    // de verdade (nenhum completeTurnForEnrollment chamado).
    await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
      enrollmentId,
    ]);

    const tick2 = await runFollowupTick(makeTickDeps(jobs), { limit: 5 });
    expect(tick2.advanced).toBe(1);
    expect(jobs).toHaveLength(1); // NÃO reenfileirou um 2º classify turn

    const afterTick2 = await getEnrollment(enrollmentId);
    expect(afterTick2.current_node_id).toBe("no-reply-node");
    expect(afterTick2.status).toBe("active");

    const { rows: events } = await pool.query(
      `select event_type from followup_enrollment_events where enrollment_id = $1 order by created_at`,
      [enrollmentId],
    );
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["classify_enqueued", "node_advanced"]);
  });
});

// ---- 4. plano de tempo: o ciclo inteiro do modo adaptativo, contra o banco ----

describe("plano de tempo — acionamento decide, espera obedece", () => {
  it("ciclo completo: o trigger pede o plano, a ponte grava, e a espera usa o instante PLANEJADO (não o máximo)", async () => {
    const org = "bbbbbbb5-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, SMART_WAIT_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "t1" });

    // 1. O acionamento enfileira o planejamento, levando as esperas do fluxo.
    const jobs: FollowupJobRequest[] = [];
    await runFollowupTick(makeTickDeps(jobs), { limit: 5 });
    const planJob = jobs.find((j) => j.payload.followup_enrollment_id === enrollmentId);
    expect(planJob?.payload).toMatchObject({ node_id: "t1", purpose: "plan_timing" });
    expect(planJob?.payload.waits).toEqual([
      {
        node_id: "w1",
        label: "Wait smart",
        min_ms: 600_000,
        max_ms: 1_800_000,
        guidance: "não insistir de madrugada",
      },
    ]);

    // CONTRATO entre as duas pontas. O engine emite este payload e quem o lê é o
    // handler do worker, do outro lado da fila — e as duas metades só casam por
    // convenção: o schema tem `.passthrough()` e `waits` é opcional, então um
    // nome de campo divergente passa pela validação e só explode no worker, em
    // produção. Aqui o payload REAL do engine atravessa o schema REAL do handler.
    const aceito = followupTurnPayloadSchema.parse(planJob!.payload);
    expect(aceito.purpose).toBe("plan_timing");
    expect(aceito.waits).toEqual(planJob!.payload.waits);
    expect((await getEnrollment(enrollmentId)).current_node_id).toBe("t1"); // ainda no trigger

    // 2. O turno volta com a proposta; a ponte clampa contra o grafo e grava.
    await completeTurnForEnrollment(db, org, enrollmentId, "t1", {
      kind: "planned",
      modelo: "anthropic/claude-sonnet-4-6",
      propostas: [{ node_id: "w1", aguardar_ms: 900_000, motivo: "lead engajado, retomar no mesmo dia" }],
    });

    const planejado = await getEnrollment(enrollmentId);
    expect(planejado.current_node_id).toBe("w1");
    const plano = planejado.timing_plan as { esperas: Record<string, { escolhido_ms: number; motivo: string }> };
    expect(plano.esperas.w1).toMatchObject({
      escolhido_ms: 900_000,
      motivo: "lead engajado, retomar no mesmo dia",
      clampado: false,
    });

    // 3. A ESPERA. É aqui que a versão anterior falhava: ela agendava max_ms
    //    (30min) qualquer que fosse o plano — a tela oferecia adaptativo e o
    //    motor esperava sempre o teto.
    //
    //    O empurrão de `next_eval_at` para o passado não é conveniência: a ponte
    //    grava o instante com o relógio do PROCESSO e o claim compara com o
    //    `now()` do POSTGRES. Os dois relógios não são o mesmo, e quando o do
    //    processo está à frente por alguns milissegundos o enrollment não é
    //    devido, o tick não o reclama, e `next_eval_at` fica valendo o instante
    //    do passo anterior — o teste falharia por corrida de relógio, sem nada a
    //    ver com o plano. Em produção isso é invisível (o tick seguinte vem em
    //    um minuto); aqui os dois passos são consecutivos.
    await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
      enrollmentId,
    ]);
    const antes = Date.now();
    await runFollowupTick(makeTickDeps(jobs), { limit: 5 });
    const esperando = await getEnrollment(enrollmentId);
    expect(esperando.current_node_id).toBe("w1"); // fica no nó, só agenda
    const nextEvalAt = new Date(esperando.next_eval_at as string).getTime();
    expect(nextEvalAt).toBeGreaterThanOrEqual(antes + 900_000 - 2_000);
    expect(nextEvalAt).toBeLessThan(antes + 900_000 + 5_000);
    // e a diferença é observável: o máximo do nó fica MUITO acima do agendado.
    expect(nextEvalAt).toBeLessThan(antes + 1_800_000 - 60_000);
  });

  it("proposta acima do máximo é grampeada no nó, com o pedido original preservado", async () => {
    const org = "bbbbbbb6-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, SMART_WAIT_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "t1", stepsTaken: 2 });

    await completeTurnForEnrollment(db, org, enrollmentId, "t1", {
      kind: "planned",
      modelo: "m",
      propostas: [{ node_id: "w1", aguardar_ms: 3 * 86_400_000, motivo: "esperar 3 dias" }],
    });

    const plano = (await getEnrollment(enrollmentId)).timing_plan as {
      esperas: Record<string, { escolhido_ms: number; proposto_ms: number; clampado: boolean }>;
    };
    expect(plano.esperas.w1).toMatchObject({
      escolhido_ms: 1_800_000,
      proposto_ms: 3 * 86_400_000,
      clampado: true,
    });
  });

  it("fluxo SEM espera adaptativa não pede plano nenhum — o acionamento não paga modelo", async () => {
    const org = "bbbbbbb7-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, FIXED_WAIT_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "t1" });

    const jobs: FollowupJobRequest[] = [];
    await runFollowupTick(makeTickDeps(jobs), { limit: 5 });

    expect(jobs.some((j) => j.payload.followup_enrollment_id === enrollmentId)).toBe(false);
    const after = await getEnrollment(enrollmentId);
    expect(after.current_node_id).toBe("w1"); // avançou direto, como antes desta feature
    expect(after.timing_plan).toBeNull();
  });

  it("enrollment sem plano na espera adaptativa cai no máximo — compatibilidade v1", async () => {
    const org = "bbbbbbb8-0000-4000-8000-000000000001";
    await seedOrg(org);
    const contactId = await seedContact(org);
    const { pointerId, versionId } = await seedFlow(org, SMART_WAIT_GRAPH);
    const enrollmentId = await seedEnrollment({ org, pointerId, versionId, contactId, currentNodeId: "w1", stepsTaken: 2 });

    const antes = Date.now();
    await runFollowupTick(makeTickDeps([]), { limit: 5 });

    const after = await getEnrollment(enrollmentId);
    const nextEvalAt = new Date(after.next_eval_at as string).getTime();
    expect(nextEvalAt).toBeGreaterThanOrEqual(antes + 1_800_000 - 2_000);
  });
});


it("o dossiê distingue uma mensagem aguardando o canal de um pedido para o agente escrever", async () => {
  const org = "bbbbbbba-0000-4000-8000-000000000001";
  await seedOrg(org);
  const contactId = await seedContact(org);
  const { pointerId, versionId } = await seedFlow(org, ACTION_GRAPH);
  const enrollmentId = await seedEnrollment({
    org, pointerId, versionId, contactId, currentNodeId: "a1",
  });
  const jobs: FollowupJobRequest[] = [];
  await runFollowupTick(makeTickDeps(jobs), { limit: 5 });
  expect(jobs).toHaveLength(1);
  const { rows: [job] } = await pool.query(
    "insert into job_queue(organization_id, contact_id, kind, payload) values ($1, $2, 'followup_turn', $3) returning id",
    [org, contactId, JSON.stringify(jobs[0]!.payload)],
  );
  const outcome = await sendWithLedger(
    pgSendLedger(pool),
    { tenantId: org, leadId: contactId, jobId: job.id, seq: 1, body: "Lembrete de teste" },
    async (_key, messageId) => ({ id: messageId, status: "queued" }),
  );
  expect(outcome.kind).toBe("queued");
  const { rows: ledger } = await pool.query(
    "select status from send_ledger where organization_id=$1 and job_id=$2",
    [org, job.id],
  );
  expect(ledger).toEqual([{ status: "queued" }]);

  const rows = await eventosDoDossiePg(org, enrollmentId);
  const titulos = rows.map((row) => descreveEvento(row, {}, "pt-BR").titulo);
  expect(titulos).not.toContain("Mensagem enviada");
  expect(titulos).toContain("Mensagem aguardando o canal");
});

async function eventosDoDossiePg(org: string, enrollmentId: string): Promise<EventoDeEnrollment[]> {
  const { rows: [schema] } = await pool.query("select to_regclass('public.followup_delivery_events') as entrega");
  const entregar = schema.entrega
    ? `union all select id, node_id, event_type, payload, created_at
                 from followup_delivery_events where organization_id=$1 and enrollment_id=$2`
    : "";
  const { rows } = await pool.query<EventoDeEnrollment>(
    `select id, node_id, event_type, payload, created_at
      from followup_enrollment_events where organization_id=$1 and enrollment_id=$2
      ${entregar} order by created_at, id`,
    [org, enrollmentId],
  );
  return rows;
}

async function prepararEnvioDoDossie(
  mode: "ai_message" | "text" | "template" | "confirm" = "ai_message",
) {
  const org = crypto.randomUUID();
  await seedOrg(org);
  const contactId = await seedContact(org);
  const graph = structuredClone(ACTION_GRAPH);
  const action = graph.nodes[0]!;
  if (action.type !== "action") throw new Error("fixture sem ação");
  if (mode === "text") action.config = { mode, body: "Lembrete fixo de teste" };
  if (mode === "template") {
    const { rows: [modelo] } = await pool.query(
      "insert into message_templates (organization_id, title, body) values ($1,'Modelo de teste','Retomando nosso contato.') returning id",
      [org],
    );
    action.config = { mode, template_id: modelo.id };
  }
  if (mode === "confirm") {
    graph.nodes[0] = {
      ...action, type: "match_reply",
      config: {
        branches: [{ id: "sim", label: "Sim", op: "eq", pattern: "sim" }],
        grace_timeout_ms: 900_000,
        save_to: { kind: "contact_name" },
        if_exists: "confirm",
      },
    };
  }
  const { pointerId, versionId } = await seedFlow(org, graph);
  const enrollmentId = await seedEnrollment({
    org, pointerId, versionId, contactId, currentNodeId: "a1",
  });
  const { rows: [origem] } = await pool.query<{
    conversation_id: string; channel_session_id: string;
  }>(`select e.conversation_id, c.channel_session_id
       from followup_enrollments e join conversations c on c.id = e.conversation_id
       where e.id = $1`, [enrollmentId]);
  const { conversation_id: conversationId, channel_session_id: sessionId } = origem!;
  await pool.query(`update contacts set name = 'Contato fictício', phone_number = '+5511999999999'
                     where organization_id = $1 and id = $2`, [org, contactId]);
  const jobs: JobRow[] = [];
  const { failed } = await runFollowupTick({
    ...makeTickDeps([]),
    enqueueJob: async (request) => {
      const { job } = await enqueueJob(pool, org, {
        kind: "followup_turn",
        leadId: contactId,
        payload: request.payload,
      });
      jobs.push(job);
    },
  }, { limit: 5 });
  expect(failed).toBe(0);
  expect(jobs).toHaveLength(1);
  const eventos = () => eventosDoDossiePg(org, enrollmentId);
  return { org, contactId, conversationId, sessionId, enrollmentId, job: jobs[0]!, eventos };
}

type CenarioDeEnvio = Awaited<ReturnType<typeof prepararEnvioDoDossie>>;

function canalDeTeste(cenario: CenarioDeEnvio, status: "queued" | "sent" | "failed"): ChannelAdapter {
  return {
    channel: "captura",
    sessionHealth: async () => ({ healthy: true, status: "WORKING", since: null }),
    capabilities: () => ({ freeformAnytime: true, serviceWindowHours: null }),
    costPerMessage: () => ({ perMessageUsdCents: 0, model: "flat" }),
    async send(input: Parameters<ChannelAdapter["send"]>[0]) {
      const outcome = await sendWithLedger(pgSendLedger(pool), { ...input, leadId: cenario.contactId }, async (_key, messageId) => {
        await pool.query(
          `insert into messages
            (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via)
            values ($1,$2,$3,$4,$5,'text','outbound','queued',$6,'ai')
            on conflict (id) do nothing`,
          [messageId, cenario.org, cenario.conversationId, cenario.sessionId, cenario.contactId, input.body],
        );
        if (status !== "queued") {
          await pool.query("update messages set status=$3 where id=$1 and organization_id=$2", [
            messageId, cenario.org, status,
          ]);
        }
        return { id: messageId, status };
      });
      if (outcome.kind === "blocked") return outcome;
      if (outcome.kind === "sent") {
        return { ...outcome, messageId: outcome.crmMessageId! };
      }
      return { ...outcome, messageId: outcome.crmMessageId };
    },
  };
}

function turnoDeTeste(canal: ChannelAdapter, corpo?: string) {
  let chamado = false;
  const uso = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const registry = createFakeRegistry(async () => {
    if (corpo !== undefined && !chamado) {
      chamado = true;
      return {
        content: [{
          type: "tool-call", toolCallId: "c1", toolName: "send_message",
          input: JSON.stringify({ body: corpo }),
        }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: uso, warnings: [],
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ lead_facts: {}, open_threads: [], commitments: [], objections: [],
          next_action: null, rolling_summary: "Turno de teste." }),
      }],
      finishReason: { unified: "stop", raw: undefined }, usage: uso, warnings: [],
    };
  });
  return createFollowupTurnHandler({
    crmCfg: { supabase: {} as never } as never,
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 20,
      maxContextTokens: 4000,
      notesIndexMaxTokens: 500,
      maxSteps: 6,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3,
        sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5,
      },
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    registry,
    channel: () => canal,
    clock: () => new Date("2026-11-24T15:00:00Z"),
    sleep: async () => {},
    completeFollowupTurn: async (p, { organizationId, enrollmentId, nodeId, jobId, jobClaim, result }) => {
      await completeTurnForEnrollment(createPgAdminClient(p), organizationId, enrollmentId, nodeId,
        result, undefined, jobId, jobClaim);
    },
  });
}

async function adquirirEnvio(jobId: string) {
  const workerId = "historico-de-envio";
  await pool.query(
    "update job_queue set status='done', locked_at=null, locked_by=null where id<>$1 and status in ('pending','running')",
    [jobId],
  );
  const [job] = await claimJobs(pool, { workerId, maxConcurrency: 1, batchSize: 1 });
  expect(job?.id).toBe(jobId);
  return { job: job!, workerId };
}

async function rodarTurnoDeEnvio(
  cenario: CenarioDeEnvio,
  status: "queued" | "sent" | "failed",
  corpo?: string,
  canal = canalDeTeste(cenario, status),
) {
  const { job, workerId } = await adquirirEnvio(cenario.job.id);
  const handler = turnoDeTeste(canal, corpo);
  try {
    await handler(job, pool, { workerId });
  } finally {
    await completeJob(pool, job.id, workerId);
  }
}

async function publicarAgente(cenario: CenarioDeEnvio, assistido = false, bolhas = false) {
  const { org, contactId, conversationId, sessionId, enrollmentId } = cenario;
  await pool.query(`with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', 'Assistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id
     )
     insert into playbook_pointers(organization_id, layer, version_id)
       select null, 'platform', id from v`);
  const { rows: [agent] } = await pool.query(
    `insert into ai_agents (organization_id, name, system_prompt, kind, operation_mode)
     values ($1, 'Agente fictício', 'Escreva um lembrete curto.', 'mcp_agent', $2) returning id`,
    [org, assistido ? 'assisted' : 'automatic'],
  );
  const { rows: [version] } = await pool.query(
    `insert into ai_agent_versions (organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, split_messages, split_max_chars)
     values ($1, $2, 1, 'Escreva um lembrete curto.', 'anthropic', 'claude-do-teste', $3, 'published', now(), $4, 100)
     returning id`, [org, agent.id, sessionId, bolhas],
  );
  await pool.query("update ai_agents set published_version_id=$2 where id=$1", [agent.id, version.id]);
  await pool.query("update followup_enrollments set agent_id=$2 where id=$1", [enrollmentId, agent.id]);
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,'text','inbound','delivered','Pode me chamar amanhã.','external_device', now() - interval '1 day')`,
    [org, conversationId, sessionId, contactId],
  );

}

it("registra geração, fila real e aceitação tardia de uma mensagem escrita no turno", async () => {
  const cenario = await prepararEnvioDoDossie();
  const { org, enrollmentId, job, eventos } = cenario;
  await publicarAgente(cenario);

  const titulos = async () => (await eventos()).map((row) => descreveEvento(row, {}, "pt-BR").titulo);
  const entrada = await titulos();
  await expect(rodarTurnoDeEnvio(cenario, "queued", "Olá! Podemos conversar amanhã?")).rejects.toThrow("followup_message_not_sent");
  const fila = await titulos();
  const { rows: [ledger] } = await pool.query(
    "select status, crm_message_id from send_ledger where organization_id=$1 and job_id=$2", [org, job.id],
  );
  expect(ledger?.status).toBe("queued");

  await pool.query(
    "update followup_enrollments set status='cancelled', next_eval_at=null where organization_id=$1 and id=$2",
    [org, enrollmentId],
  );
  // Simula o expurgo do job e a atualização do recibo no mesmo id físico.
  await pool.query("delete from job_queue where organization_id=$1 and id=$2", [org, job.id]);
  for (const status of ["sent", "delivered", "read"]) {
    await pool.query("update messages set status=$3 where organization_id=$1 and id=$2", [
      org, ledger.crm_message_id, status,
    ]);
  }
  expect((await getEnrollment(enrollmentId)).status).toBe("cancelled");
  expect(entrada).toContain("Tarefa de envio enfileirada");
  expect(fila.slice(-2)).toEqual(["Mensagem gerada", "Mensagem aguardando o canal"]);
  expect((await titulos()).slice(-3)).toEqual([
    "Mensagem gerada", "Mensagem aguardando o canal", "Mensagem enviada",
  ]);
  expect(JSON.stringify(await eventos())).not.toContain("Podemos conversar");
});

it("registra o texto fixo aceito sem inventar geração ou fila do canal", async () => {
  const cenario = await prepararEnvioDoDossie("text");
  await rodarTurnoDeEnvio(cenario, "sent");
  expect((await getEnrollment(cenario.enrollmentId)).current_node_id).toBe("e1");
  const trilha = (await cenario.eventos()).map((e) => e.event_type);
  expect(trilha.filter((tipo) => tipo.startsWith("followup_"))).toEqual([
    "followup_job_queued", "followup_message_sent",
  ]);
});


it.each([
  { mode: "template", node: "e1", status: "active" },
  { mode: "confirm", node: "a1", status: "waiting_reply" },
] as const)("o modo $mode registra o recibo sem geração de IA", async ({ mode, node, status }) => {
  const cenario = await prepararEnvioDoDossie(mode);
  await rodarTurnoDeEnvio(cenario, "sent");
  expect((await getEnrollment(cenario.enrollmentId))).toMatchObject({
    current_node_id: node, status,
  });
  const trilha = (await cenario.eventos()).map((e) => e.event_type);
  expect(trilha.filter((tipo) => tipo.startsWith("followup_"))).toEqual([
    "followup_job_queued", "followup_message_sent",
  ]);
});

it("preserva a falha quando o mesmo job reenvia com nova mensagem física", async () => {
  const cenario = await prepararEnvioDoDossie("text");
  await expect(rodarTurnoDeEnvio(cenario, "failed")).rejects.toThrow("CRM marcou o envio como failed");
  const falhou = (await cenario.eventos()).find((e) => e.event_type === "followup_message_failed");
  expect(falhou?.payload.message_id).toBeTruthy();
  expect((await getEnrollment(cenario.enrollmentId)).current_node_id).toBe("a1");

  await pool.query("update job_queue set status='pending' where organization_id=$1 and id=$2", [
    cenario.org, cenario.job.id,
  ]);
  await rodarTurnoDeEnvio(cenario, "sent");
  const trilha = await cenario.eventos();
  expect(trilha.filter((e) => e.event_type === "followup_message_failed")).toHaveLength(1);
  const saiu = trilha.filter((e) => e.event_type === "followup_message_sent");
  expect(saiu).toHaveLength(1);
  expect(saiu[0]?.payload.message_id).not.toBe(falhou?.payload.message_id);
  expect(saiu[0]?.payload.source_step_key).toBe(falhou?.payload.source_step_key);
});

it("a mensagem sai e o passo avança quando gravar o histórico falha", async () => {
  const cenario = await prepararEnvioDoDossie("text");
  await pool.query(`create function falha_do_historico() returns trigger language plpgsql as $$
    begin raise exception 'falha injetada no histórico'; end;
  $$;
  create trigger falha_do_historico before insert on followup_delivery_events
    for each row execute function falha_do_historico();`);
  try {
    await rodarTurnoDeEnvio(cenario, "sent");
    const { rows } = await pool.query(
      "select status from send_ledger where organization_id=$1 and job_id=$2",
      [cenario.org, cenario.job.id],
    );
    expect(rows).toEqual([{ status: "accepted" }]);
    expect((await getEnrollment(cenario.enrollmentId)).current_node_id).toBe("e1");
    expect((await cenario.eventos()).some((e) => e.event_type === "followup_message_sent")).toBe(false);
  } finally {
    await pool.query(`drop trigger falha_do_historico on followup_delivery_events;
                      drop function falha_do_historico();`);
  }
});

async function criarMembro(org: string) {
  const membro = crypto.randomUUID();
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [membro, `${membro}@invariant.test`]);
  await pool.query("insert into user_organizations(user_id, organization_id, role) values ($1,$2,'manager')", [
    membro, org,
  ]);
  return membro;
}

it("o texto editado e aprovado tem recibo na inscrição que originou o rascunho", async () => {
  const cenario = await prepararEnvioDoDossie();
  // O envio aprovado avalia a janela pelo relógio real: aberta o dia todo, o caso não depende da hora do CI.
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,window_start_hour,window_end_hour) values($1,$2,0,0,0,24)",
    [cenario.org, cenario.sessionId],
  );
  await publicarAgente(cenario, true);
  await rodarTurnoDeEnvio(cenario, "sent", "Podemos retomar a conversa esta semana?");
  const { rows: [draft] } = await pool.query(
    "select id, revision::text, status from ai_reply_drafts where organization_id=$1 and conversation_id=$2",
    [cenario.org, cenario.conversationId],
  );
  expect(draft?.status).toBe("pending");
  const gerado = (await cenario.eventos()).find((e) => e.event_type === "followup_draft_generated");
  expect(gerado?.payload.draft_id).toBe(draft.id);
  const membro = await criarMembro(cenario.org);
  const textoEditado = "Podemos conversar na quinta-feira?";
  const sessao = await pool.connect();
  let aprovado: string;
  try {
    await sessao.query("begin");
    await sessao.query("set local role authenticated");
    await sessao.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: membro })]);
    const { rows } = await sessao.query(
      "select fn_reply_action($1,$2,$3,'approve',$4) as id",
      [cenario.org, draft.id, draft.revision, textoEditado],
    );
    aprovado = rows[0].id;
    await sessao.query("commit");
  } catch (error) {
    await sessao.query("rollback");
    throw error;
  } finally {
    sessao.release();
  }
  const { job } = await adquirirEnvio(aprovado);
  const canal = canalDeTeste(cenario, "sent");
  const handler = createApprovedReplyHandler({
    crmCfg: { supabase: {} as never } as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sleep: async () => {},
    channel: () => ({
      async send(input) {
        expect(input.body).toBe(textoEditado);
        return canal.send(input);
      },
    }),
  });
  await handler(job, pool);
  const recebidos = (await cenario.eventos()).filter((e) => e.event_type === "followup_message_sent");
  expect(recebidos).toHaveLength(1);
  expect(recebidos[0]?.payload.job_id).toBe(aprovado);
  expect(recebidos[0]?.payload.source_step_key).toBe(gerado?.payload.source_step_key);
});

it("fica sem evento de geração quando o turno encerra sem escrever mensagem", async () => {
  const cenario = await prepararEnvioDoDossie();
  await publicarAgente(cenario);
  await rodarTurnoDeEnvio(cenario, "sent");
  expect((await cenario.eventos()).filter((e) => e.event_type.startsWith("followup_")).map((e) => e.event_type))
    .toEqual(["followup_job_queued"]);
});

it("mostra envio parcial quando alguém segura a segunda parte antes da intenção no ledger", async () => {
  const cenario = await prepararEnvioDoDossie();
  await publicarAgente(cenario, false, true);
  const canal = canalDeTeste(cenario, "sent");
  await rodarTurnoDeEnvio(cenario, "sent", [
    "Olá! Estou voltando porque nossa conversa ficou em aberto e ainda posso ajudar.",
    "Se quiser, escolha um horário nesta semana para a gente conversar com calma.",
  ].join("\n\n"), {
    ...canal,
    async send(input) {
      const resultado = await canal.send(input);
      await pool.query(
        "update conversations set bot_silenced_until='infinity' where organization_id=$1 and id=$2",
        [cenario.org, cenario.conversationId],
      );
      return resultado;
    },
  });
  const entregas = (await cenario.eventos()).filter((e) => e.event_type.startsWith("followup_"));
  expect(entregas.map((e) => e.event_type)).toEqual([
    "followup_job_queued", "followup_message_generated", "followup_message_sent", "followup_send_partial",
  ]);
  const { rows } = await pool.query("select seq from send_ledger where job_id=$1", [cenario.job.id]);
  expect(rows).toEqual([{ seq: 1 }]);
});

it("expõe os recibos para a própria organização e reserva as escritas para o sistema", async () => {
  const destaOrg = await prepararEnvioDoDossie("text");
  const outraOrg = await prepararEnvioDoDossie("text");
  const membro = await criarMembro(destaOrg.org);

  const conexao = await pool.connect();
  try {
    await conexao.query("begin");
    await conexao.query("set local role authenticated");
    await conexao.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: membro })]);
    const { rows } = await conexao.query(
      "select enrollment_id from followup_delivery_events where enrollment_id = any($1::uuid[])",
      [[destaOrg.enrollmentId, outraOrg.enrollmentId]],
    );
    expect(rows).toEqual([{ enrollment_id: destaOrg.enrollmentId }]);
    await expect(conexao.query(
      `insert into followup_delivery_events (organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
       values ($1,$2,'a1','followup_message_sent','{}','induzido')`,
      [destaOrg.org, destaOrg.enrollmentId],
    )).rejects.toMatchObject({ code: "42501" });
  } finally {
    await conexao.query("rollback");
    conexao.release();
  }
});

it("o recibo segue a mesma regra de escrita do sistema que o ledger", async () => {
  const cenario = await prepararEnvioDoDossie();
  await publicarAgente(cenario);
  await expect(rodarTurnoDeEnvio(cenario, "queued", "Olá! Podemos conversar amanhã?")).rejects.toThrow("followup_message_not_sent");
  const { rows: [ledger] } = await pool.query(
    "select crm_message_id from send_ledger where organization_id=$1 and job_id=$2", [cenario.org, cenario.job.id],
  );
  const enviadas = async () => (await cenario.eventos()).filter((e) => e.event_type === "followup_message_sent");
  const membro = await criarMembro(cenario.org);

  const conexao = await pool.connect();
  try {
    await conexao.query("begin");
    await conexao.query("set local role authenticated");
    await conexao.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: membro })]);
    const { rowCount } = await conexao.query(
      "update messages set status='sent' where organization_id=$1 and id=$2", [cenario.org, ledger.crm_message_id],
    );
    expect(rowCount).toBe(1);
    const { rows } = await conexao.query(
      "select 1 from followup_delivery_events where enrollment_id=$1 and event_type='followup_message_sent'",
      [cenario.enrollmentId],
    );
    expect(rows).toEqual([]);
  } finally {
    await conexao.query("rollback");
    conexao.release();
  }

  // Controle: a mesma atualização feita pelo sistema registra o recibo.
  await pool.query("update messages set status='sent' where organization_id=$1 and id=$2", [
    cenario.org, ledger.crm_message_id,
  ]);
  expect(await enviadas()).toHaveLength(1);
});
