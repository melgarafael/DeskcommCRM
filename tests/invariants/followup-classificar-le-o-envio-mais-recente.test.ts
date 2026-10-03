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
 * O CLASSIFICAR LÊ A RESPOSTA AO ENVIO MAIS RECENTE DO FLUXO — NÃO A UM ENVIO ANTIGO.
 *
 * O candidato à classificação é a resposta do lead ao envio DO FLUXO
 * (`respostaAoEnvioDoFluxo` em lib/agent-engine/agent/followup-turn.ts), e o
 * marco desse envio é o `action_sent` mais recente da inscrição
 * (`envioDoFluxoFechadoEm`, `max(created_at)`). Os arquivos irmãos
 * (`followup-classificar-espera-a-resposta`, `followup-classificar-ciclo-completo`)
 * têm UM envio só, e com um envio só `max` e `min` são o mesmo instante: trocar
 * um pelo outro passava verde (medido pela verificação cética).
 *
 * O fluxo aqui tem DOIS envios e DOIS classificar, que é o desenho comum de
 * "insistir uma vez": o lead recusa a 1ª oferta, o fluxo manda a 2ª e espera de
 * novo. Se o marco fosse o 1º envio, o 2º classificar leria a recusa antiga como
 * resposta à 2ª oferta — chamaria o modelo e sairia pela classe dela segundos
 * depois do envio, com o lead sem ter dito nada.
 *
 * Caminho de produção contra Postgres real, como nos irmãos: tick do motor com o
 * adapter pg do worker, `job_queue` com o INSERT das rotas de cron, `claimJobs`,
 * o handler real com a ponte ligada. Só o MODELO é dublê; o envio é gravado como
 * o envio o grava e concluído pela MESMA ponte que o worker chama.
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

const WORKER = "classificar-envio-recente";
const CARENCIA_MS = 24 * 60 * 60 * 1000;
const ENVIO = "Oi! Posso te mandar o link do plano?";
const SEGUNDO_ENVIO = "Tudo bem! E se eu te mandar uma proposta com desconto?";
const RECUSA = "agora não, obrigado";
const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const P = { x: 0, y: 0 };
const classificar = (id: string, label: string) => ({
  id,
  type: "ai_classify" as const,
  label,
  position: P,
  config: { classes: ["quer", "não quer"], grace_timeout_ms: CARENCIA_MS, target: "last_reply" as const },
});

/** Oferta → classifica; "não quer" → 2ª oferta → classifica de novo. */
const GRAFO: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: P, config: {} },
    { id: "a1", type: "action", label: "Oferta", position: P, config: { mode: "text", body: ENVIO } },
    classificar("c1", "Classificar resposta"),
    { id: "a2", type: "action", label: "Segunda oferta", position: P, config: { mode: "text", body: SEGUNDO_ENVIO } },
    classificar("c2", "Classificar de novo"),
    { id: "e_quer", type: "end", label: "Quer", position: P, config: { outcome: "converted" } },
    { id: "e_nao", type: "end", label: "Desiste", position: P, config: { outcome: "exhausted" } },
    { id: "e_sem", type: "end", label: "Sem resposta", position: P, config: { outcome: "exhausted" } },
    { id: "e_outros", type: "end", label: "Outros", position: P, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "t1-a1", source: "t1", target: "a1", priority: 0, condition: { type: "always" } },
    { id: "a1-c1", source: "a1", target: "c1", priority: 0, condition: { type: "always" } },
    { id: "c1-quer", source: "c1", target: "e_quer", priority: 0, condition: { type: "class_match", value: "quer" } },
    { id: "c1-nao", source: "c1", target: "a2", priority: 0, condition: { type: "class_match", value: "não quer" } },
    { id: "c1-sem", source: "c1", target: "e_sem", priority: 0, condition: { type: "class_match", value: "no_reply" } },
    { id: "c1-outros", source: "c1", target: "e_outros", priority: 0, condition: { type: "always" } },
    { id: "a2-c2", source: "a2", target: "c2", priority: 0, condition: { type: "always" } },
    { id: "c2-quer", source: "c2", target: "e_quer", priority: 0, condition: { type: "class_match", value: "quer" } },
    { id: "c2-nao", source: "c2", target: "e_nao", priority: 0, condition: { type: "class_match", value: "não quer" } },
    { id: "c2-sem", source: "c2", target: "e_sem", priority: 0, condition: { type: "class_match", value: "no_reply" } },
    { id: "c2-outros", source: "c2", target: "e_outros", priority: 0, condition: { type: "always" } },
  ],
};

// ---- o modelo dublê: registra o que recebeu e responde a classe da vez ----

let promptsAoModelo: string[] = [];
let classeDoDuble = "não quer";
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

// ---- a fila e o motor como produção ----

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

async function vencerAgora(enrollmentId: string): Promise<void> {
  await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [
    enrollmentId,
  ]);
}

async function enrollment(id: string): Promise<{ current_node_id: string; status: string; last_error: string | null }> {
  const { rows } = await pool.query(`select current_node_id, status, last_error from followup_enrollments where id = $1`, [id]);
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

/** Folga entre mensagens: o contexto do handler trunca `sent_at` no segundo. */
const umPouco = () => new Promise((r) => setTimeout(r, 1100));

/**
 * O envio de uma ação pelo caminho do worker: o tick enfileira o turno de envio,
 * o worker o reivindica, a mensagem de saída é gravada e o passo fecha pela ponte.
 */
async function enviar(c: Cenario, nodeId: string, texto: string, haSegundos: number): Promise<void> {
  await vencerAgora(c.enrollmentId);
  await tick();
  const [envio] = await jobsPendentes(c.enrollmentId);
  expect(envio?.payload).toMatchObject({ node_id: nodeId, purpose: "send_message", fixed_body: texto });
  const job = await reivindicar(envio!.id);
  await mensagem(c, "outbound", texto, haSegundos);
  await completeTurnForEnrollment(createPgAdminClient(pool), c.org, c.enrollmentId, nodeId, { kind: "sent" }, undefined, job.id, claimOfJob(job));
  await completeJob(pool, job.id, WORKER);
}

/**
 * Org + contato que já conversou, o fluxo publicado, e o enrollment levado PELO
 * MOTOR até a 1ª entrada no 1º classificar (o 1º job de classificar pendente).
 */
async function cenario(): Promise<Cenario> {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Classificar Recente', 'Classificar Recente')`,
    [org, `classificar-recente-${org}`],
  );
  const { rows: ct } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Lead', '+5511900001748') returning id`,
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
    [org, JSON.stringify(GRAFO)],
  );
  const { rows: ptr } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, 'Oferta e insistência', 'active', $2) returning id`,
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
  await enviar(c, "a1", ENVIO, 60);
  expect((await enrollment(c.enrollmentId)).current_node_id).toBe("c1");
  await vencerAgora(c.enrollmentId);
  await tick(); // 1ª entrada no 1º classificar
  expect(await enrollment(c.enrollmentId)).toMatchObject({ current_node_id: "c1", status: "waiting_reply" });
  return c;
}

/**
 * O lead recusa a 1ª oferta, o 1º classificar lê a recusa, e o fluxo manda a 2ª
 * oferta e entra no 2º classificar. Devolve com o 2º job de classificar pendente.
 */
async function ateOSegundoClassificar(respostaASegunda?: string): Promise<Cenario> {
  const c = await cenario();
  await mensagem(c, "inbound", RECUSA, 0);
  expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);
  expect((await enrollment(c.enrollmentId)).current_node_id).toBe("a2");
  expect(promptsAoModelo).toHaveLength(1);
  expect(promptsAoModelo[0]).toContain(RECUSA);

  await umPouco();
  await enviar(c, "a2", SEGUNDO_ENVIO, 0);
  expect((await enrollment(c.enrollmentId)).current_node_id).toBe("c2");
  if (respostaASegunda !== undefined) {
    await umPouco();
    await mensagem(c, "inbound", respostaASegunda, 0);
  }
  await vencerAgora(c.enrollmentId);
  await tick(); // 1ª entrada no 2º classificar
  expect(await enrollment(c.enrollmentId)).toMatchObject({ current_node_id: "c2", status: "waiting_reply" });
  return c;
}

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
  await pool.query(`delete from job_queue where kind = 'followup_turn'`);
  promptsAoModelo = [];
  classeDoDuble = "não quer";
});

describe("o grafo do teste é o que o construtor publica", () => {
  it("passa no schema e no validador de publish de produção", () => {
    flowGraphSchema.parse(GRAFO);
    expect(validateFlowForPublish(GRAFO)).toEqual({ ok: true });
  });
});

describe("o 2º classificar lê a resposta ao 2º envio, nunca a resposta ao 1º", () => {
  it("sem resposta à 2ª oferta: o 2º classificar ESPERA — a recusa à 1ª não é classificada de novo", async () => {
    const c = await ateOSegundoClassificar();

    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);

    expect(await enrollment(c.enrollmentId)).toMatchObject({ current_node_id: "c2", status: "waiting_reply", last_error: null });
    expect(promptsAoModelo, "o 2º classificar chamou o modelo com uma resposta que não era à 2ª oferta").toHaveLength(1);
    const noSegundo = (await eventos(c.enrollmentId)).filter((e) => e.node_id === "c2");
    expect(noSegundo.map((e) => e.event_type)).toEqual(["classify_enqueued", "classify_waiting"]);

    // E a espera termina como toda espera: pela carência, com o desfecho gravado.
    await vencerAgora(c.enrollmentId);
    await tick();
    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e_sem");
    const saida = (await eventos(c.enrollmentId)).filter((e) => e.node_id === "c2" && e.event_type === "node_advanced");
    expect(saida.map((e) => e.payload)).toEqual([{ next_node_id: "e_sem", class: "no_reply" }]);
    expect(promptsAoModelo).toHaveLength(1);
  });

  it("controle: COM resposta à 2ª oferta, o 2º classificar lê a resposta NOVA e sai pela classe dela", async () => {
    const c = await ateOSegundoClassificar("pode ser, me manda a proposta");
    classeDoDuble = "quer";

    expect(await rodarJobsDoFluxo(c.enrollmentId)).toBe(1);

    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e_quer");
    expect(promptsAoModelo).toHaveLength(2);
    expect(promptsAoModelo[1]).toContain("pode ser, me manda a proposta");
    expect(promptsAoModelo[1]).not.toContain(RECUSA);
  });
});
