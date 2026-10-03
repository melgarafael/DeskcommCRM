import { criarOrigemDeFollowup } from "./followup-service-origin";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createFollowupTurnHandler, type FollowupTurnDeps } from "@/lib/agent-engine/agent/followup-turn";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { claimJobs, completeJob, failJob } from "@/lib/agent-engine/queue/queue";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { applyReactivityEvent, LIVE_STATUSES, type ReactivityAdminClient } from "@/lib/followup/reactivity";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { isolarFixtureDeFollowup } from "./followup-isolamento";
import { relogioAncoradoNoBanco } from "./followup-relogio";

/**
 * "MANDA A MENSAGEM → CLASSIFICA A RESPOSTA": O CICLO INTEIRO, DEPOIS DO CONSERTO.
 *
 * `followup-classificar-espera-a-resposta.test.ts` prova que o 1º job de
 * classificar, sem resposta, não consome a espera. Não prova o que vem DEPOIS
 * dele — e foi aí que a verificação cética achou três defeitos:
 *
 *   1. a saída "sem resposta" passou a acontecer só pela carência vencida, que
 *      gravava `node_advanced` sem classe. A condição "Desfecho do passo
 *      anterior" (`last_outcome`, #527) lia `null` e mandava o lead pelo outro
 *      ramo em silêncio (caso "desfecho");
 *   2. o candidato à classificação era "a última inbound depois do último
 *      outbound de QUALQUER um": o lead respondia, o agente respondia antes do
 *      job, e a resposta sumia — saída por "sem resposta" com o cliente tendo
 *      respondido (caso C, o comum numa organização com agente ativo);
 *   3. o job que espera não deixava rastro no dossiê — "Pediu ao agente para
 *      interpretar a resposta" e mais nada por até a carência inteira (caso D).
 *
 * Caminho de produção contra Postgres real, como no arquivo irmão: tick do motor
 * com o adapter pg do worker, `job_queue` com o INSERT das rotas de cron,
 * `claimJobs`, o handler real com a ponte ligada, as funções de banco que guardam
 * o job. A resposta do lead entra pelo gatilho REAL de `messages` (a linha
 * `message.received` de `event_log`) e é entregue à reatividade de produção
 * (`applyReactivityEvent`). Só o MODELO é dublê. O relógio só é forçado onde a
 * espera é a carência de 24 h (casos B e desfecho).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

const WORKER = "classificar-ciclo";
const CARENCIA_MS = 24 * 60 * 60 * 1000;
const ENVIO = "Oi! Posso te mandar o link do plano?";
const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// ---- os grafos como o construtor grava (ver o arquivo irmão) ----

const P = { x: 0, y: 0 };
const CLASSIFICAR = {
  id: "c1",
  type: "ai_classify" as const,
  label: "Classificar resposta",
  position: P,
  config: { classes: ["quer", "não quer"], grace_timeout_ms: CARENCIA_MS, target: "last_reply" as const },
};
const INICIO_E_ENVIO: FlowGraph["nodes"] = [
  { id: "t1", type: "trigger", label: "Início", position: P, config: {} },
  { id: "a1", type: "action", label: "Oferta", position: P, config: { mode: "text", body: ENVIO } },
  CLASSIFICAR,
];
const ARESTAS_DO_ENVIO: FlowGraph["edges"] = [
  { id: "t1-a1", source: "t1", target: "a1", priority: 0, condition: { type: "always" } },
  { id: "a1-c1", source: "a1", target: "c1", priority: 0, condition: { type: "always" } },
];

const GRAFO: FlowGraph = {
  nodes: [
    ...INICIO_E_ENVIO,
    { id: "e_quer", type: "end", label: "Quer", position: P, config: { outcome: "converted" } },
    { id: "e_nao", type: "end", label: "Não quer", position: P, config: { outcome: "exhausted" } },
    { id: "e_sem", type: "end", label: "Sem resposta", position: P, config: { outcome: "exhausted" } },
    { id: "e_outros", type: "end", label: "Outros", position: P, config: { outcome: "exhausted" } },
  ],
  edges: [
    ...ARESTAS_DO_ENVIO,
    { id: "c1-quer", source: "c1", target: "e_quer", priority: 0, condition: { type: "class_match", value: "quer" } },
    { id: "c1-nao", source: "c1", target: "e_nao", priority: 0, condition: { type: "class_match", value: "não quer" } },
    { id: "c1-sem", source: "c1", target: "e_sem", priority: 0, condition: { type: "class_match", value: "no_reply" } },
    { id: "c1-outros", source: "c1", target: "e_outros", priority: 0, condition: { type: "always" } },
  ],
};

/**
 * "Não quer" e "Sem resposta" caem na MESMA condição, e é ela que separa os dois
 * pelo desfecho: `last_outcome` diferente de "não quer" → tenta de novo.
 */
const GRAFO_DESFECHO: FlowGraph = {
  nodes: [
    ...INICIO_E_ENVIO,
    {
      id: "k1",
      type: "condition",
      label: "Desfecho não foi recusa?",
      position: P,
      config: { combinator: "and", checks: [{ field: "last_outcome", op: "neq", value: "não quer" }] },
    },
    { id: "e_quer", type: "end", label: "Quer", position: P, config: { outcome: "converted" } },
    { id: "e_sim", type: "end", label: "Tenta de novo", position: P, config: { outcome: "exhausted" } },
    { id: "e_nao", type: "end", label: "Desiste", position: P, config: { outcome: "exhausted" } },
    { id: "e_outros", type: "end", label: "Outros", position: P, config: { outcome: "exhausted" } },
  ],
  edges: [
    ...ARESTAS_DO_ENVIO,
    { id: "c1-quer", source: "c1", target: "e_quer", priority: 0, condition: { type: "class_match", value: "quer" } },
    { id: "c1-nao", source: "c1", target: "k1", priority: 0, condition: { type: "class_match", value: "não quer" } },
    { id: "c1-sem", source: "c1", target: "k1", priority: 0, condition: { type: "class_match", value: "no_reply" } },
    { id: "c1-outros", source: "c1", target: "e_outros", priority: 0, condition: { type: "always" } },
    { id: "k1-sim", source: "k1", target: "e_sim", priority: 0, condition: { type: "cond_result", value: true } },
    { id: "k1-nao", source: "k1", target: "e_nao", priority: 0, condition: { type: "cond_result", value: false } },
  ],
};

// ---- o modelo dublê: registra o que recebeu e responde a classe da vez ----

let promptsAoModelo: string[] = [];
let classeDoDuble = "quer";
const registry = createFakeRegistry((async (options: { prompt: unknown }) => {
  promptsAoModelo.push(JSON.stringify(options.prompt));
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ class: classeDoDuble }) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}) as never);

const turnDeps: FollowupTurnDeps = {
  crmCfg: { supabase: {} as never } as never,
  llmCfg: { anthropicApiKey: "fake" } as never,
  knobs: {
    historyLimit: 20,
    maxContextTokens: 4000,
    notesIndexMaxTokens: 500,
    maxSteps: 12,
    queuedRetryDelayMs: 1000,
    breaker: {
      exactFailureWarn: 2,
      exactFailureBlock: 5,
      sameToolFailureWarn: 3,
      sameToolFailureHalt: 8,
      noProgressWarn: 3,
      noProgressBlock: 5,
    },
    followupAi: { model: "claude-sonnet-4-6" },
  },
  log,
  registry,
  completeFollowupTurn: (p, { organizationId, enrollmentId, nodeId, jobId, jobClaim, result }) =>
    completeTurnForEnrollment(createPgAdminClient(p), organizationId, enrollmentId, nodeId, result, undefined, jobId, jobClaim),
};
const handler = createFollowupTurnHandler(turnDeps);

// ---- a fila, o motor e a reatividade como produção ----

async function enfileirarComoProducao(job: FollowupJobRequest): Promise<void> {
  await pool.query(
    `insert into job_queue (organization_id, contact_id, kind, payload) values ($1, $2, 'followup_turn', $3)`,
    [job.organization_id, job.contact_id, job.payload],
  );
}

const tickDeps: TickDeps = {
  db: createPgAdminClient(pool),
  clock: relogioAncoradoNoBanco(),
  enqueueJob: enfileirarComoProducao,
};

async function tick(): Promise<void> {
  const r = await runFollowupTick(tickDeps, { limit: 5 });
  expect(r.failed, "o tick falhou num enrollment — ver last_error").toBe(0);
}

/** Espelho de `createSupabaseReactivityClient` em pg (mesmas colunas, `updated_at` inclusive). */
const reatividade: ReactivityAdminClient = {
  async loadConversationContactId(orgId, conversationId) {
    const { rows } = await pool.query(`select contact_id from conversations where id = $1 and organization_id = $2`, [
      conversationId,
      orgId,
    ]);
    return rows[0]?.contact_id ?? null;
  },
  async loadContactBlocked(orgId, contactId) {
    const { rows } = await pool.query(`select is_blocked from contacts where id = $1 and organization_id = $2`, [
      contactId,
      orgId,
    ]);
    return rows[0]?.is_blocked ?? false;
  },
  async loadLiveEnrollmentsForContact(orgId, contactId, statuses = LIVE_STATUSES) {
    const { rows } = await pool.query(
      `select e.id, e.status, e.current_node_id, e.steps_taken, e.pointer_id, e.updated_at, p.handoff_policy, p.trigger_config
         from followup_enrollments e join followup_flow_pointers p on p.id = e.pointer_id
        where e.organization_id = $1 and e.contact_id = $2 and e.status = any($3)`,
      [orgId, contactId, statuses],
    );
    return rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() }));
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
    await pool.query(
      `update followup_enrollments set ${entries.map(([k], n) => `${k} = $${n + 3}`).join(", ")}
        where id = $1 and organization_id = $2`,
      [id, orgId, ...entries.map(([, v]) => v)],
    );
  },
  async agoraNoBanco() {
    const { rows } = await pool.query(`select public.fn_agora() as agora`);
    return new Date(rows[0].agora).toISOString();
  },
};

async function vencerAgora(enrollmentId: string): Promise<void> {
  await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
    enrollmentId,
  ]);
}

async function enrollment(id: string): Promise<{ current_node_id: string; status: string; next_eval_at: Date | null; last_error: string | null }> {
  const { rows } = await pool.query(
    `select current_node_id, status, next_eval_at, last_error from followup_enrollments where id = $1`,
    [id],
  );
  return rows[0];
}

async function eventos(
  id: string,
): Promise<{ id: string; node_id: string; event_type: string; payload: Record<string, unknown>; created_at: string }[]> {
  const { rows } = await pool.query(
    `select id, node_id, event_type, payload, created_at::text from followup_enrollment_events
      where enrollment_id = $1 order by created_at, id`,
    [id],
  );
  return rows;
}

async function jobsPendentes(enrollmentId: string): Promise<{ id: string; payload: Record<string, unknown> }[]> {
  const { rows } = await pool.query(
    `select id, payload from job_queue
      where kind = 'followup_turn' and status = 'pending' and payload->>'followup_enrollment_id' = $1
      order by created_at`,
    [enrollmentId],
  );
  return rows;
}

async function jobsDeClassificar(enrollmentId: string): Promise<{ status: string; attempts: number }[]> {
  const { rows } = await pool.query(
    `select status, attempts from job_queue
      where kind = 'followup_turn' and payload->>'purpose' = 'classify' and payload->>'followup_enrollment_id' = $1
      order by created_at`,
    [enrollmentId],
  );
  return rows;
}

async function reivindicar(jobId: string) {
  const [job] = await claimJobs(pool, { workerId: WORKER, maxConcurrency: 5, batchSize: 1 });
  expect(job?.id, "o claim do worker pegou outro job").toBe(jobId);
  return job!;
}

/** Roda pelo HANDLER REAL todo `followup_turn` pendente deste enrollment. */
async function rodarJobsDoFluxo(enrollmentId: string): Promise<number> {
  const pendentes = await jobsPendentes(enrollmentId);
  for (const p of pendentes) {
    const job = await reivindicar(p.id);
    try {
      await handler(job, pool, { workerId: WORKER });
      await completeJob(pool, job.id, WORKER);
    } catch (err) {
      await failJob(pool, job.id, WORKER, err);
      throw err;
    }
  }
  return pendentes.length;
}

interface Cenario {
  org: string;
  contato: string;
  conversa: string;
  sessao: string;
  enrollmentId: string;
}

async function mensagem(c: Cenario, direcao: "inbound" | "outbound", texto: string, haSegundos: number): Promise<void> {
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', $6, $7, $8, $9, now() - make_interval(secs => $10))`,
    [
      randomUUID(),
      c.org,
      c.conversa,
      c.sessao,
      c.contato,
      direcao,
      direcao === "inbound" ? "delivered" : "sent",
      texto,
      direcao === "inbound" ? "external_device" : "ai",
      haSegundos,
    ],
  );
}

/**
 * A folga antes da resposta: a reatividade só acorda a espera com a inbound
 * enviada DEPOIS de a espera começar (`inboundEhDestaPergunta`, comparação de
 * instantes em texto). Aqui a espera e a resposta nasceriam no mesmo segundo;
 * no mundo, o lead leva mais que isso para ler e responder.
 */
const umPouco = () => new Promise((r) => setTimeout(r, 1100));

/** O lead responde: grava a inbound e entrega à reatividade a linha REAL de `event_log` que o gatilho de `messages` emitiu. */
async function leadResponde(c: Cenario, texto: string): Promise<void> {
  await mensagem(c, "inbound", texto, 0);
  const { rows } = await pool.query(
    `select id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, created_at
       from event_log where organization_id = $1 and event_type = 'message.received' order by created_at desc limit 1`,
    [c.org],
  );
  expect(rows[0], "o gatilho de messages não emitiu message.received").toBeTruthy();
  const row = { ...rows[0], created_at: new Date(rows[0].created_at).toISOString() } as EventRow;
  expect(await applyReactivityEvent(reatividade, () => new Date(), row)).toEqual({ matched: true, reacted: 1 });
}

/**
 * Org + contato que já conversou, o fluxo publicado e o enrollment levado PELO
 * MOTOR até o classificar (o envio fecha pela MESMA ponte que o worker chama).
 * `entrar: true` roda também a 1ª entrada no classificar (o tick que enfileira o
 * 1º job); `false` para logo depois do envio.
 */
async function cenario(grafo: FlowGraph, entrar: boolean): Promise<Cenario> {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Classificar Ciclo', 'Classificar Ciclo')`,
    [org, `classificar-ciclo-${org}`],
  );
  const { rows: ct } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Lead', '+5511900001747') returning id`,
    [org],
  );
  const contato = ct[0]!.id;
  const origem = await criarOrigemDeFollowup(pool, org, contato);
  const { rows: cv } = await pool.query<{ channel_session_id: string }>(
    `select channel_session_id from conversations where id = $1`,
    [origem.conversation_id],
  );
  await pool.query(`update conversations set service_started_at = now() - interval '1 hour' where id = $1`, [
    origem.conversation_id,
  ]);
  const parcial = { org, contato, conversa: origem.conversation_id, sessao: cv[0]!.channel_session_id };
  await mensagem({ ...parcial, enrollmentId: "" }, "inbound", "oi, queria saber do plano", 50 * 60);
  const boundary = await criarOrigemDeFollowup(pool, org, contato);

  const { rows: ver } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(grafo)],
  );
  const { rows: ptr } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, 'Oferta com classificação', 'active', $2) returning id`,
    [org, ver[0]!.id],
  );
  const { rows: en } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at,
        steps_taken, conversation_id, service_boundary)
     values ($1, $2, $3, $4, 't1', 'active', now() - interval '1 second', 0, $5, $6::jsonb)
     returning id`,
    [org, ptr[0]!.id, ver[0]!.id, contato, boundary.conversation_id, JSON.stringify(boundary)],
  );
  const c: Cenario = { ...parcial, enrollmentId: en[0]!.id };

  await tick(); // trigger → a1
  expect((await enrollment(c.enrollmentId)).current_node_id).toBe("a1");
  await vencerAgora(c.enrollmentId);
  await tick(); // a1 enfileira o envio

  const [envio] = await jobsPendentes(c.enrollmentId);
  expect(envio?.payload).toMatchObject({ node_id: "a1", purpose: "send_message", fixed_body: ENVIO });
  const job = await reivindicar(envio!.id);
  await mensagem(c, "outbound", ENVIO, 60);
  await completeTurnForEnrollment(
    createPgAdminClient(pool),
    org,
    c.enrollmentId,
    "a1",
    { kind: "sent" },
    undefined,
    job.id,
    claimOfJob(job),
  );
  await completeJob(pool, job.id, WORKER);
  expect((await enrollment(c.enrollmentId)).current_node_id).toBe("c1");

  if (entrar) {
    await vencerAgora(c.enrollmentId);
    await tick(); // 1ª entrada no classificar
    expect(await enrollment(c.enrollmentId)).toMatchObject({ current_node_id: "c1", status: "waiting_reply" });
  }
  return c;
}

/** Até o lead chegar num nó `end`: vence a espera do nó e deixa o motor andar. */
async function andarAteOFim(enrollmentId: string): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const e = await enrollment(enrollmentId);
    if (e.current_node_id.startsWith("e_")) return e.current_node_id;
    await vencerAgora(enrollmentId);
    await tick();
  }
  return (await enrollment(enrollmentId)).current_node_id;
}

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
  await pool.query(`delete from job_queue where kind = 'followup_turn'`);
  promptsAoModelo = [];
  classeDoDuble = "quer";
});

describe("os grafos do teste são o que o construtor publica", () => {
  it.each([
    ["classificar", GRAFO],
    ["desfecho", GRAFO_DESFECHO],
  ])("%s: passa no schema e no validador de publish de produção", (_nome, grafo) => {
    flowGraphSchema.parse(grafo);
    expect(validateFlowForPublish(grafo)).toEqual({ ok: true });
  });
});

describe("classificar a resposta: o ciclo inteiro", () => {
  it("D: o job sem resposta termina (1 tentativa), deixa o rastro da espera no dossiê e não mexe no enrollment", async () => {
    const c = await cenario(GRAFO, true);
    const antes = await enrollment(c.enrollmentId);

    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);
    for (let i = 0; i < 3; i++) await tick();

    const depois = await enrollment(c.enrollmentId);
    expect(await jobsDeClassificar(c.enrollmentId)).toEqual([{ status: "done", attempts: 1 }]);
    expect(depois).toMatchObject({ current_node_id: "c1", status: "waiting_reply", last_error: null });
    expect(new Date(depois.next_eval_at!).getTime()).toBe(new Date(antes.next_eval_at!).getTime());
    expect(await jobsPendentes(c.enrollmentId)).toHaveLength(0);

    // O rastro: UMA linha, no classificar, com o prazo que o nó está de fato usando.
    const espera = (await eventos(c.enrollmentId)).filter((e) => e.event_type === "classify_waiting");
    expect(espera).toHaveLength(1);
    expect(espera[0]!.node_id).toBe("c1");
    expect(new Date(String(espera[0]!.payload.until)).getTime()).toBe(new Date(depois.next_eval_at!).getTime());
    // E o dossiê o diz em português, pela mesma função que a tela chama.
    const lido = descreveEvento(espera[0]!, {}, "pt-BR");
    expect(lido.titulo).toBe("Esperando a resposta do cliente");
    expect(lido.detalhe).toMatch(/^se ele não responder até .+, o fluxo segue sem a resposta$/);
    expect(promptsAoModelo).toHaveLength(0);
  });

  it("A: a resposta chega DEPOIS do job vazio — a reatividade acorda o nó, o tick (sem forçar relógio) enfileira o 2º job, e ele classifica", async () => {
    const c = await cenario(GRAFO, true);
    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);

    await umPouco();
    await leadResponde(c, "quero sim, me manda o link");
    await tick();

    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);
    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e_quer");
    expect(promptsAoModelo).toHaveLength(1);
    expect(promptsAoModelo[0]).toContain("quero sim, me manda o link");
    const classificado = (await eventos(c.enrollmentId)).filter((e) => e.event_type === "ai_classified");
    expect(classificado.map((e) => [e.node_id, e.payload])).toEqual([["c1", { class: "quer" }]]);
  });

  it("C: o lead responde e o AGENTE responde antes do job de classificar — a resposta do lead AO ENVIO DO FLUXO é classificada", async () => {
    const c = await cenario(GRAFO, true);
    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);

    await umPouco();
    await leadResponde(c, "quero sim, me manda o link");
    // O agente de atendimento responde na hora; o job de classificar só sai no tick seguinte.
    await mensagem(c, "outbound", "Que ótimo! Já te mando o link.", 0);
    await tick();

    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);
    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e_quer");
    expect(promptsAoModelo).toHaveLength(1);
    expect(promptsAoModelo[0]).toContain("quero sim, me manda o link");
    expect(promptsAoModelo[0]).not.toContain("Que ótimo");
  });

  it("E: a resposta chega entre o envio e a 1ª entrada no classificar — o 1º job já classifica", async () => {
    const c = await cenario(GRAFO, false);

    await umPouco();
    await leadResponde(c, "quero sim");
    await tick(); // 1ª entrada, acordada pela resposta — sem forçar relógio

    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);
    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e_quer");
    expect(promptsAoModelo).toHaveLength(1);
    expect(promptsAoModelo[0]).toContain("quero sim");
  });

  it("B: sem resposta até a carência vencer — o tick sai por 'sem resposta' sem modelo e sem job novo, e GRAVA o desfecho", async () => {
    const c = await cenario(GRAFO, true);
    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);

    await vencerAgora(c.enrollmentId);
    await tick();

    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e_sem");
    const saida = (await eventos(c.enrollmentId)).filter((e) => e.node_id === "c1" && e.event_type === "node_advanced");
    expect(saida.map((e) => e.payload)).toEqual([{ next_node_id: "e_sem", class: "no_reply" }]);
    expect(descreveEvento(saida[0]!, {}, "pt-BR").titulo).toBe("O cliente não respondeu dentro do prazo");
    expect(await jobsPendentes(c.enrollmentId)).toHaveLength(0);
    expect(promptsAoModelo).toHaveLength(0);
  });
});

describe("'Desfecho do passo anterior' depois de sair do classificar (#527)", () => {
  it("sem resposta até a carência: a condição 'desfecho não foi \"não quer\"' lê no_reply e manda o lead para 'Tenta de novo'", async () => {
    const c = await cenario(GRAFO_DESFECHO, true);
    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);

    expect(await andarAteOFim(c.enrollmentId)).toBe("e_sim");
    const evs = (await eventos(c.enrollmentId)).map((e) => [e.node_id, e.event_type, e.payload]);
    expect(evs).toContainEqual(["c1", "node_advanced", { next_node_id: "k1", class: "no_reply" }]);
    expect(evs).toContainEqual(["k1", "node_advanced", { next_node_id: "e_sim" }]);
  });

  it("controle: o lead responde e o modelo classifica 'não quer' — a MESMA condição manda para 'Desiste'", async () => {
    classeDoDuble = "não quer";
    const c = await cenario(GRAFO_DESFECHO, true);
    await mensagem(c, "inbound", "não quero, obrigado", 0);
    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);

    expect(await andarAteOFim(c.enrollmentId)).toBe("e_nao");
    expect(promptsAoModelo).toHaveLength(1);
  });
});
