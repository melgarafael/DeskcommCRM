import { criarOrigemDeFollowup } from "./followup-service-origin";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createFollowupTurnHandler, type FollowupTurnDeps } from "@/lib/agent-engine/agent/followup-turn";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { claimJobs, completeJob, failJob } from "@/lib/agent-engine/queue/queue";
import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { isolarFixtureDeFollowup } from "./followup-isolamento";
import { relogioAncoradoNoBanco } from "./followup-relogio";

/**
 * "MANDA A MENSAGEM → CLASSIFICA A RESPOSTA (ESPERA 24 h)" TEM DE ESPERAR A RESPOSTA.
 *
 * O fluxo mais natural do construtor é uma ação de envio seguida de um nó
 * "Classificar (IA)" com carência de 24 h. A promessa da tela — e do desenho
 * (`docs/superpowers/specs/2026-07-21-followup-system-design.md`, §ai_classify:
 * "entra → waiting_reply; classifica quando (a) inbound chega ou (b) timeout
 * vence") — é: o lead tem as 24 h para responder; só depois disso o fluxo segue
 * por "sem resposta".
 *
 * O caminho de produção ATÉ O CONSERTO, lido no código e MEDIDO aqui na main
 * 610142d21:
 *   1. a 1ª entrada no `ai_classify` devolve `enqueue_turn(classify)` na hora
 *      (`node-handlers.ts`, `case "ai_classify"`), e o motor enfileira o
 *      `followup_turn` SEM `run_after` — o worker o pega no poll seguinte;
 *   2. o handler (`runFlowDrivenTurn`, ramo `classify`) passa como candidato
 *      `lastInboundSinceLastOutbound(...)`, que é `null` quando a última
 *      mensagem é o nosso envio — e `classifyFollowupReply` devolve `no_reply`
 *      sem chamar o modelo;
 *   3. a ponte (`completeTurnForEnrollment`) aplica `classified:no_reply` e
 *      AVANÇA pela saída "sem resposta" — segundos depois do envio. A carência
 *      de 24 h nunca corre.
 *
 * Tudo aqui é produção contra Postgres real: o tick do motor com o adapter pg
 * do worker, a fila `job_queue` com o INSERT das rotas de cron, o `claimJobs`
 * do worker, o handler `createFollowupTurnHandler` com a ponte ligada como em
 * `workers/agent-worker/main.ts`, e as funções de banco que guardam o job
 * (`fn_followup_job_current`, `fn_followup_claim_current`,
 * `fn_followup_apply_step`). Só o MODELO é dublê. O envio da ação não passa
 * pela cadeia de canal (não é o que está sob teste): o turno de envio é
 * reivindicado da fila, a mensagem de saída é gravada como o envio a grava, e
 * a conclusão vai pela MESMA ponte que o worker chama.
 *
 * Quatro casos. A catraca nasceu `it.fails` e foi virada para `it` no conserto
 * (o turno de classify sem resposta nova termina sem concluir o passo):
 *   - controle positivo (normal): o caminho inteiro roda sem exceção, com o
 *     enrollment posto no classificar PELO MOTOR. Existia porque `it.fails` é
 *     satisfeito por QUALQUER falha — fixture quebrada ou throw no handler
 *     deixariam a catraca verde pelo motivo errado; aqui eles reprovam alto;
 *   - a catraca: sem resposta, o job não consome a espera;
 *   - controle 1: COM resposta depois do envio, o job classifica pela classe do
 *     dublê e segue pela aresta dela;
 *   - controle 2: sem resposta e com a carência vencida, o TICK roteia no_reply.
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

const WORKER = "classificar-espera";
const CARENCIA_MS = 24 * 60 * 60 * 1000;
const ENVIO = "Oi! Posso te mandar o link do plano?";
const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// ---- o grafo como o construtor grava ----
//
// `ai_classify` v1 (classes, sem `branches`: o `ClassifyForm` emite v1 de
// propósito), arestas `class_match:<classe>` e `class_match:no_reply` saídas das
// bolinhas (`conditionForBranch`), `always` na saída "Outros", todas prioridade 0
// (`onConnect`). O publish é conferido abaixo com o validador de produção.
const P = { x: 0, y: 0 };
const GRAFO: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: P, config: {} },
    { id: "a1", type: "action", label: "Oferta", position: P, config: { mode: "text", body: ENVIO } },
    {
      id: "c1",
      type: "ai_classify",
      label: "Classificar resposta",
      position: P,
      config: { classes: ["quer", "não quer"], grace_timeout_ms: CARENCIA_MS, target: "last_reply" },
    },
    { id: "e_quer", type: "end", label: "Quer", position: P, config: { outcome: "converted" } },
    { id: "e_nao", type: "end", label: "Não quer", position: P, config: { outcome: "exhausted" } },
    { id: "e_sem", type: "end", label: "Sem resposta", position: P, config: { outcome: "exhausted" } },
    { id: "e_outros", type: "end", label: "Outros", position: P, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "t1-a1", source: "t1", target: "a1", priority: 0, condition: { type: "always" } },
    { id: "a1-c1", source: "a1", target: "c1", priority: 0, condition: { type: "always" } },
    { id: "c1-quer", source: "c1", target: "e_quer", priority: 0, condition: { type: "class_match", value: "quer" } },
    { id: "c1-nao", source: "c1", target: "e_nao", priority: 0, condition: { type: "class_match", value: "não quer" } },
    { id: "c1-sem", source: "c1", target: "e_sem", priority: 0, condition: { type: "class_match", value: "no_reply" } },
    { id: "c1-outros", source: "c1", target: "e_outros", priority: 0, condition: { type: "always" } },
  ],
};

// ---- o modelo dublê: registra o que recebeu e responde a classe "quer" ----

let promptsAoModelo: string[] = [];
const registry = createFakeRegistry((async (options: { prompt: unknown }) => {
  promptsAoModelo.push(JSON.stringify(options.prompt));
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ class: "quer" }) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}) as never);

/** Deps do handler como `workers/agent-worker/main.ts` monta — só o modelo é dublê. */
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

// ---- a fila como produção: o INSERT das rotas de cron / relógio ----

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
  // O motor ENGOLE erro de enrollment (vira `attempts++`). Sem isto um defeito de
  // fixture viraria "o enrollment não andou", que imita o comportamento sob teste.
  expect(r.failed, "o tick falhou num enrollment — ver last_error").toBe(0);
}

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

async function eventos(id: string): Promise<{ node_id: string; event_type: string; payload: Record<string, unknown> }[]> {
  const { rows } = await pool.query(
    `select node_id, event_type, payload from followup_enrollment_events where enrollment_id = $1 order by created_at, id`,
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

/** Reivindica UM job da fila pelo claim do worker e confere que é o esperado. */
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

async function mensagem(c: Cenario, direcao: "inbound" | "outbound", texto: string, haSegundos: number): Promise<void> {
  // Instantes EXPLÍCITOS e segundos inteiros de distância, não `clock_timestamp()`:
  // o contexto que o handler lê trunca `sent_at` em SEGUNDOS (`isoLocalComOffset`),
  // e `lastInboundSinceLastOutbound` exige inbound ESTRITAMENTE depois do envio.
  // Medido: com `clock_timestamp()` envio e resposta caíam no mesmo segundo e a
  // resposta era lida como "não é depois do envio" — o controle 1 dava no_reply.
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

interface Cenario {
  org: string;
  contato: string;
  conversa: string;
  sessao: string;
  enrollmentId: string;
}

/**
 * Org + contato que JÁ conversou (uma inbound antiga, na demanda aberta), o fluxo
 * publicado, e o enrollment levado PELO MOTOR do acionamento até o classificar:
 *   tick(trigger → a1) → tick(a1 enfileira o envio) → o worker reivindica o envio,
 *   grava a mensagem de saída e fecha pela ponte (a1 → c1) → tick(c1).
 * Ao voltar, a última mensagem da conversa é o NOSSO envio.
 */
async function cenarioAteOClassificar(): Promise<Cenario> {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Classificar Espera', 'Classificar Espera')`,
    [org, `classificar-espera-${org}`],
  );
  const { rows: ct } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Lead', '+5511900001746') returning id`,
    [org],
  );
  const contato = ct[0]!.id;
  const origem = await criarOrigemDeFollowup(pool, org, contato);
  const { rows: cv } = await pool.query<{ channel_session_id: string }>(
    `select channel_session_id from conversations where id = $1`,
    [origem.conversation_id],
  );
  // O atendimento começou há uma hora (o lead já vinha conversando). Sem isto o
  // envio, datado de 1 min atrás, cairia antes de `service_started_at` e o
  // contexto do handler o descartaria (`get-lead-context.ts`, filtro de outbound).
  await pool.query(`update conversations set service_started_at = now() - interval '1 hour' where id = $1`, [
    origem.conversation_id,
  ]);
  const parcial = { org, contato, conversa: origem.conversation_id, sessao: cv[0]!.channel_session_id };
  await mensagem({ ...parcial, enrollmentId: "" }, "inbound", "oi, queria saber do plano", 50 * 60);
  // A fronteira de HOJE (com a demanda que a inbound abriu), como o enroll a congela.
  const boundary = await criarOrigemDeFollowup(pool, org, contato);

  const { rows: ver } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(GRAFO)],
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

  await vencerAgora(c.enrollmentId);
  await tick(); // 1ª entrada no classificar
  return c;
}

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
  await pool.query(`delete from job_queue where kind = 'followup_turn'`);
  promptsAoModelo = [];
});

describe("o grafo do teste é o que o construtor publica", () => {
  it("passa no schema e no validador de publish de produção", () => {
    flowGraphSchema.parse(GRAFO);
    expect(validateFlowForPublish(GRAFO)).toEqual({ ok: true });
  });
});

describe("classificar a resposta espera a resposta", () => {
  it("controle positivo: o motor põe o enrollment no classificar e o job roda inteiro pelo handler real, sem chamar o modelo", async () => {
    const c = await cenarioAteOClassificar();

    const antes = await enrollment(c.enrollmentId);
    expect(antes.current_node_id).toBe("c1");
    expect(antes.status).toBe("waiting_reply");
    expect((await eventos(c.enrollmentId)).map((e) => e.event_type)).toContain("action_sent");

    await rodarJobsDoFluxo(c.enrollmentId);

    const { rows } = await pool.query<{ status: string }>(
      `select status from job_queue where kind = 'followup_turn' and payload->>'followup_enrollment_id' = $1`,
      [c.enrollmentId],
    );
    expect(rows.every((r) => r.status === "done")).toBe(true);
    expect(promptsAoModelo).toHaveLength(0);
  });

  /**
   * Era VERMELHO NA MAIN (610142d21), e por isso nasceu `it.fails`. Medido: depois
   * do job, o enrollment estava em `e_sem` (status `active`), com o evento
   * `ai_classified {class: "no_reply"}` no nó `c1` — o lead tinha os segundos
   * entre o envio e o poll do worker para responder, não as 24 h do nó.
   *
   * Virada para `it` no conserto: sem resposta nova, o turno de classify termina
   * sem concluir o passo, e quem roteia `no_reply` é o tick quando a carência
   * vence (controle 2).
   */
  it("sem resposta do cliente, o job NÃO consome a espera: o enrollment segue no classificar, em waiting_reply, sem saída no_reply", async () => {
    const c = await cenarioAteOClassificar();
    const antes = Date.now();

    await rodarJobsDoFluxo(c.enrollmentId);

    const depois = await enrollment(c.enrollmentId);
    const evs = await eventos(c.enrollmentId);
    expect(
      { no: depois.current_node_id, status: depois.status, classificacoes: evs.filter((e) => e.event_type === "ai_classified") },
      "o job de classificar avançou o enrollment sem resposta do cliente",
    ).toEqual({ no: "c1", status: "waiting_reply", classificacoes: [] });
    // A carência inteira continua valendo.
    expect(new Date(depois.next_eval_at!).getTime()).toBeGreaterThan(antes + CARENCIA_MS - 60_000);
    expect(promptsAoModelo).toHaveLength(0);
  });

  it("controle 1: com resposta do lead depois do envio, o job classifica pelo modelo e segue pela aresta da classe", async () => {
    const c = await cenarioAteOClassificar();
    await mensagem(c, "inbound", "quero sim, me manda o link", 0);

    await rodarJobsDoFluxo(c.enrollmentId);

    expect(promptsAoModelo).toHaveLength(1);
    expect(promptsAoModelo[0]).toContain("quero sim, me manda o link");
    expect(promptsAoModelo[0]).not.toContain("oi, queria saber do plano");
    const depois = await enrollment(c.enrollmentId);
    expect(depois.current_node_id).toBe("e_quer");
    const classificado = (await eventos(c.enrollmentId)).filter((e) => e.event_type === "ai_classified");
    expect(classificado).toEqual([expect.objectContaining({ node_id: "c1", payload: { class: "quer" } })]);
  });

  it("controle 2: sem resposta e com a carência vencida, o TICK do motor roteia no_reply sem chamar o modelo", async () => {
    const c = await cenarioAteOClassificar();
    // O job de classificar (se a 1ª entrada enfileirou um) não chegou a rodar.
    await pool.query(
      `delete from job_queue where kind = 'followup_turn' and status = 'pending' and payload->>'followup_enrollment_id' = $1`,
      [c.enrollmentId],
    );
    await vencerAgora(c.enrollmentId);

    await tick();

    const depois = await enrollment(c.enrollmentId);
    expect(depois.current_node_id).toBe("e_sem");
    const evs = await eventos(c.enrollmentId);
    expect(evs.filter((e) => e.event_type === "ai_classified")).toEqual([]);
    expect(evs.at(-1)).toMatchObject({ node_id: "c1", event_type: "node_advanced" });
    expect(promptsAoModelo).toHaveLength(0);
  });
});
