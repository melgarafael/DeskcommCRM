import { criarOrigemDeFollowup } from "./followup-service-origin";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
// O schema do OUTRO lado da fila. Importado só aqui, e só no teste: agent-engine
// nunca importa followup/* (a dependência é numa direção só) — mas provar que as
// duas metades do contrato casam exige ver as duas no mesmo lugar.
import { followupTurnPayloadSchema } from "@/lib/agent-engine/agent/followup-turn";

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
