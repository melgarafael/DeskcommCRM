import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFollowupTurnHandler, type FollowupTurnDeps } from "@/lib/agent-engine/agent/followup-turn";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { claimJobs, completeJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { isolarFixtureDeFollowup } from "./followup-isolamento";
import { relogioAncoradoNoBanco } from "./followup-relogio";

/**
 * O JEV NO PASSO "CLASSIFICAR (IA)" DO FOLLOW-UP, PELO CAMINHO DE PRODUÇÃO (onda 4.1).
 *
 * O emissor é o de produção: o tick do motor com o adapter pg do worker, a fila
 * `job_queue` com o INSERT das rotas de cron, o `claimJobs` do worker e o handler
 * `createFollowupTurnHandler` com a ponte ligada como em
 * `workers/agent-worker/main.ts` — Postgres real, com o estado da tarefa em
 * `organizations.settings` e as linhas em `jev_observacoes` e `llm_calls`. A IA
 * de sempre é o registry dublê; o Jev é um `fetch` dublê injetado por `deps.jev`.
 *
 * O que se prova aqui e o unitário (`lib/ai/decisao/followup.test.ts`) não
 * alcança: a resposta que o turno escolhe e o id dela em `messages`, a
 * leitura do estado pelo `pg.Pool`, a gravação que termina DEPOIS de o passo ser
 * concluído, o índice único que segura o retry, e o fluxo andando pela saída da
 * IA de sempre com o Jev discordando.
 *
 * Cada caso tem a sua organização: o disjuntor do Jev é por organização e vive
 * no processo.
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

const WORKER = "jev-followup";
const ADMIN = "aaaaaaaa-0441-4000-8000-000000000001";
const CARENCIA_MS = 24 * 60 * 60 * 1000;
const ENVIO = "Oi! Posso te mandar o link do plano?";
const RESPOSTA = "quero sim, me liga no 11 98765-4321";
const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const LIGADO = { jev: { ligado: true, aceite: { em: "2026-09-01T12:00:00.000Z", por: ADMIN } } };

// ---- o grafo como o construtor grava (o mesmo de followup-classificar-espera-a-resposta) ----
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
      config: {
        classes: ["quer", "não quer"],
        grace_timeout_ms: CARENCIA_MS,
        target: "last_reply",
        hint: "Quem pede o link quer.",
      },
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

// ---- a IA de sempre: o registry dublê, com a saída que o caso escolher ----

let saidaDaIa = JSON.stringify({ class: "quer" });
const registry = createFakeRegistry((async () => ({
  content: [{ type: "text" as const, text: saidaDaIa }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
})) as never);

// ---- o Jev: o formato real da API; `escolhas` é a resposta de cada pedido, em ordem ----

interface Pedido {
  state: unknown;
  questions: Record<string, { type: string; instructions: string; criteria: Record<string, unknown> }>;
}

function jevDuble(...escolhas: string[]) {
  const pedidos: Pedido[] = [];
  return {
    pedidos,
    deps: {
      buscarChave: async () => "tsk_duble_do_teste",
      baseUrl: "https://jev.duble.test",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        pedidos.push(JSON.parse(String(init?.body)) as Pedido);
        const escolha = escolhas[Math.min(pedidos.length, escolhas.length) - 1]!;
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              followup: { type: "choice", choice: escolha, probabilities: { [escolha]: 0.88 }, confidence: 0.77 },
            },
            usage: { input_tokens: 240, output_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
  };
}

type DepsDoJev = ReturnType<typeof jevDuble>["deps"];

/** Deps do handler como `workers/agent-worker/main.ts` monta — a IA de sempre e o Jev são dublês. */
function handlerCom(jev: DepsDoJev, opts: { concluirFalha?: boolean } = {}) {
  const deps: FollowupTurnDeps = {
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
    jev,
    completeFollowupTurn: async (p, { organizationId, enrollmentId, nodeId, jobId, jobClaim, result }) => {
      // O retry de verdade: o passo não foi concluído, e a fila roda o MESMO job de novo.
      if (opts.concluirFalha) throw new Error("conexão caiu ao concluir o passo");
      await completeTurnForEnrollment(createPgAdminClient(p), organizationId, enrollmentId, nodeId, result, undefined, jobId, jobClaim);
    },
  };
  return createFollowupTurnHandler(deps);
}

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

async function noAtual(id: string): Promise<{ current_node_id: string; status: string }> {
  const { rows } = await pool.query(`select current_node_id, status from followup_enrollments where id = $1`, [id]);
  return rows[0];
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

async function reivindicar(jobId: string): Promise<JobRow> {
  const [job] = await claimJobs(pool, { workerId: WORKER, maxConcurrency: 5, batchSize: 1 });
  expect(job?.id, "o claim do worker pegou outro job").toBe(jobId);
  return job!;
}

/** O job de classificar que o motor enfileirou, reivindicado como o worker o reivindica. */
async function jobDeClassificar(c: Cenario): Promise<JobRow> {
  const [pendente] = await jobsPendentes(c.enrollmentId);
  expect(pendente?.payload).toMatchObject({ node_id: "c1", purpose: "classify", classes: ["quer", "não quer"] });
  return reivindicar(pendente!.id);
}

/** Uma mensagem com instante EXPLÍCITO (o contexto trunca `sent_at` no segundo). Devolve o id. */
async function mensagem(
  c: Omit<Cenario, "enrollmentId">,
  direcao: "inbound" | "outbound",
  texto: string | null,
  haSegundos: number,
  midia?: { tipo: string; derivado: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, media_url, media_derived_text)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - make_interval(secs => $11), $12, $13)`,
    [
      id,
      c.org,
      c.conversa,
      c.sessao,
      c.contato,
      midia?.tipo ?? "text",
      direcao,
      direcao === "inbound" ? "delivered" : "sent",
      texto,
      direcao === "inbound" ? "external_device" : "ai",
      haSegundos,
      midia ? "https://midia.duble.test/audio.ogg" : null,
      midia?.derivado ?? null,
    ],
  );
  return id;
}

interface Cenario {
  org: string;
  contato: string;
  conversa: string;
  sessao: string;
  enrollmentId: string;
}

/**
 * Org com o Jev em `settings`, contato que já conversou, o fluxo publicado e o
 * enrollment levado PELO MOTOR até o classificar — como em
 * `followup-classificar-espera-a-resposta`. Ao voltar, a última mensagem da
 * conversa é o NOSSO envio.
 */
async function cenarioAteOClassificar(settings: unknown): Promise<Cenario> {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings) values ($1, $2, 'Jev Followup', 'Jev Followup', $3)`,
    [org, `jev-followup-${org}`, JSON.stringify(settings)],
  );
  const { rows: ct } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Lead', '+5511900000441') returning id`,
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
  await mensagem(parcial, "inbound", "oi, queria saber do plano", 50 * 60);
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
  await vencerAgora(c.enrollmentId);
  await tick(); // a1 enfileira o envio
  const [envio] = await jobsPendentes(c.enrollmentId);
  const job = await reivindicar(envio!.id);
  await mensagem(c, "outbound", ENVIO, 60);
  await completeTurnForEnrollment(createPgAdminClient(pool), org, c.enrollmentId, "a1", { kind: "sent" }, undefined, job.id, claimOfJob(job));
  await completeJob(pool, job.id, WORKER);
  expect((await noAtual(c.enrollmentId)).current_node_id).toBe("c1");

  await vencerAgora(c.enrollmentId);
  await tick(); // 1ª entrada no classificar: enfileira o job
  return c;
}

async function observacoes(org: string) {
  const { rows } = await pool.query(
    `select tarefa, estado, conversation_id, message_id, job_id, rotulo_jev, rotulo_atual, concordou,
            probabilidade_jev::float8 as probabilidade_jev, modelo
       from jev_observacoes where organization_id = $1`,
    [org],
  );
  return rows;
}

async function chamadasDoJev(org: string) {
  const { rows } = await pool.query(
    `select purpose, provider, model, status, origem_da_escolha, job_id, contact_id, input_tokens,
            cost_cents::float8 as cost_cents
       from llm_calls where organization_id = $1 and provider = 'typesafe'`,
    [org],
  );
  return rows;
}

/** A gravação do Jev termina DEPOIS do passo concluído: espera por ela no banco. */
async function esperar<T>(ler: () => Promise<T[]>, n: number): Promise<T[]> {
  await vi.waitFor(async () => expect(await ler()).toHaveLength(n), { timeout: 5_000, interval: 50 });
  return ler();
}

/** Deixa a gravação que não deveria existir ter a chance de aparecer. */
const assentar = () => new Promise((r) => setTimeout(r, 300));

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
  await pool.query(`delete from job_queue where kind = 'followup_turn'`);
  saidaDaIa = JSON.stringify({ class: "quer" });
});

describe("o grafo e a leitura do cartão", () => {
  it("o grafo passa no schema e no validador de publish de produção", () => {
    flowGraphSchema.parse(GRAFO);
    expect(validateFlowForPublish(GRAFO)).toEqual({ ok: true });
  });

  it("a FK que a rota do cartão nomeia para embutir a versão ativa existe com esse nome", async () => {
    // `followup_flow_versions!followup_flow_pointers_active_version_id_fkey(graph)`
    // (app/api/v1/ai/jev/route.ts e a página de Credenciais): há DUAS FKs entre
    // as tabelas (a versão aponta o ponteiro também), e sem o nome o PostgREST
    // recusa o embed por ambiguidade.
    const { rows } = await pool.query(
      `select conrelid::regclass::text as tabela, confrelid::regclass::text as alvo
         from pg_constraint where conname = 'followup_flow_pointers_active_version_id_fkey'`,
    );
    expect(rows).toEqual([{ tabela: "followup_flow_pointers", alvo: "followup_flow_versions" }]);
  });
});

describe("o Jev no passo 'Classificar (IA)', pelo caminho do follow-up", () => {
  it("(a)+(b) observando: o fluxo segue pela saída da IA de sempre com o Jev discordando, e o par é gravado com a resposta certa", async () => {
    const c = await cenarioAteOClassificar(LIGADO);
    const resposta = await mensagem(c, "inbound", RESPOSTA, 0);
    const jev = jevDuble("não quer");
    const job = await jobDeClassificar(c);

    await handlerCom(jev.deps)(job, pool, { workerId: WORKER });
    await completeJob(pool, job.id, WORKER);

    // (b) A saída que move o fluxo é a da IA de sempre.
    expect(await noAtual(c.enrollmentId)).toMatchObject({ current_node_id: "e_quer" });

    // Só a resposta, sem o telefone, só a pergunta dele, as saídas do passo como opções, sem "nenhuma".
    expect(jev.pedidos).toHaveLength(1);
    const pedido = jev.pedidos[0]!;
    expect(Object.keys(pedido.questions)).toEqual(["followup"]);
    expect(Object.keys(pedido.questions.followup!.criteria)).toEqual(["quer", "não quer"]);
    expect(pedido.questions.followup!.instructions).toContain("Quem pede o link quer.");
    expect(String(pedido.state)).toContain("quero sim");
    expect(String(pedido.state)).not.toContain("98765-4321");
    expect(String(pedido.state)).not.toContain("queria saber do plano");

    // (a) O par, amarrado à resposta e ao job; o custo em llm_calls, sem texto.
    expect(await esperar(() => observacoes(c.org), 1)).toEqual([
      {
        tarefa: "followup",
        estado: "observando",
        conversation_id: c.conversa,
        message_id: resposta,
        job_id: job.id,
        rotulo_jev: "não quer",
        rotulo_atual: "quer",
        concordou: false,
        probabilidade_jev: 0.88,
        modelo: "jev-1.13.0",
      },
    ]);
    const [custo] = await esperar(() => chamadasDoJev(c.org), 1);
    expect(custo).toMatchObject({
      purpose: "followup_classify",
      model: "typesafe/jev-1.13.0",
      status: "ok",
      origem_da_escolha: "jev_observacao",
      job_id: job.id,
      contact_id: c.contato,
      input_tokens: 240,
    });
    expect(custo!.cost_cents).toBeGreaterThan(0);
  });

  it("concordando, o par diz que concordou", async () => {
    const c = await cenarioAteOClassificar(LIGADO);
    await mensagem(c, "inbound", RESPOSTA, 0);
    const job = await jobDeClassificar(c);
    await handlerCom(jevDuble("quer").deps)(job, pool, { workerId: WORKER });
    const [obs] = await esperar(() => observacoes(c.org), 1);
    expect(obs).toMatchObject({ rotulo_jev: "quer", rotulo_atual: "quer", concordou: true });
  });

  it("(c) o retry do MESMO job não conta em dobro — a primeira resposta do Jev fica, e o custo da segunda entra", async () => {
    const c = await cenarioAteOClassificar(LIGADO);
    await mensagem(c, "inbound", RESPOSTA, 0);
    const job = await jobDeClassificar(c);
    const jev = jevDuble("não quer", "quer");

    // A 1ª tentativa classifica e cai ao concluir o passo; a fila roda o mesmo job de novo.
    await expect(handlerCom(jev.deps, { concluirFalha: true })(job, pool, { workerId: WORKER })).rejects.toThrow(
      /conexão caiu/,
    );
    await esperar(() => observacoes(c.org), 1);
    await handlerCom(jev.deps)(job, pool, { workerId: WORKER });
    await completeJob(pool, job.id, WORKER);

    expect(jev.pedidos).toHaveLength(2);
    await esperar(() => chamadasDoJev(c.org), 2);
    expect(await observacoes(c.org)).toEqual([
      expect.objectContaining({ job_id: job.id, rotulo_jev: "não quer", rotulo_atual: "quer" }),
    ]);
    expect(await noAtual(c.enrollmentId)).toMatchObject({ current_node_id: "e_quer" });
  });

  it("a IA de sempre falha na 1ª tentativa: o par fica sem ela, e o retry o completa sem duplicar", async () => {
    const c = await cenarioAteOClassificar(LIGADO);
    await mensagem(c, "inbound", RESPOSTA, 0);
    const job = await jobDeClassificar(c);
    const jev = jevDuble("não quer", "quer");

    saidaDaIa = "não sei classificar";
    await expect(handlerCom(jev.deps)(job, pool, { workerId: WORKER })).rejects.toThrow(/sem classe reconhecível/);
    expect(await esperar(() => observacoes(c.org), 1)).toEqual([
      expect.objectContaining({ rotulo_jev: "não quer", rotulo_atual: null, concordou: null }),
    ]);
    // O passo não andou: a saída é da IA de sempre, e ela não respondeu.
    expect(await noAtual(c.enrollmentId)).toMatchObject({ current_node_id: "c1" });

    saidaDaIa = JSON.stringify({ class: "quer" });
    await handlerCom(jev.deps)(job, pool, { workerId: WORKER });
    await completeJob(pool, job.id, WORKER);
    await esperar(() => chamadasDoJev(c.org), 2);
    await vi.waitFor(
      async () =>
        expect(await observacoes(c.org)).toEqual([
          expect.objectContaining({ rotulo_jev: "não quer", rotulo_atual: "quer", concordou: false }),
        ]),
      { timeout: 5_000, interval: 50 },
    );
  });

  it.each([
    ["o Jev desligado na empresa", {}],
    ["só a tarefa pausada", { jev: { ...LIGADO.jev, tarefas: { followup: { estado: "desligada" } } } }],
  ])("(d) %s: nada sai para o fornecedor, nada é gravado, e o fluxo segue pela IA de sempre", async (_caso, settings) => {
    const c = await cenarioAteOClassificar(settings);
    await mensagem(c, "inbound", RESPOSTA, 0);
    const jev = jevDuble("não quer");
    const job = await jobDeClassificar(c);
    await handlerCom(jev.deps)(job, pool, { workerId: WORKER });
    await completeJob(pool, job.id, WORKER);
    await assentar();
    expect(jev.pedidos).toEqual([]);
    expect(await observacoes(c.org)).toEqual([]);
    expect(await chamadasDoJev(c.org)).toEqual([]);
    expect(await noAtual(c.enrollmentId)).toMatchObject({ current_node_id: "e_quer" });
  });

  it("(e) sem resposta ao envio (awaiting_reply): o Jev não é perguntado", async () => {
    const c = await cenarioAteOClassificar(LIGADO);
    const jev = jevDuble("não quer");
    const job = await jobDeClassificar(c);
    await handlerCom(jev.deps)(job, pool, { workerId: WORKER });
    await completeJob(pool, job.id, WORKER);
    await assentar();
    expect(jev.pedidos).toEqual([]);
    expect(await observacoes(c.org)).toEqual([]);
    expect(await noAtual(c.enrollmentId)).toMatchObject({ current_node_id: "c1", status: "waiting_reply" });
  });

  it("(f) a resposta é um áudio transcrito: a IA de sempre classifica, e o Jev não é perguntado", async () => {
    const c = await cenarioAteOClassificar(LIGADO);
    await mensagem(c, "inbound", null, 0, { tipo: "audio", derivado: "quero sim, pode mandar o link" });
    const jev = jevDuble("não quer");
    const job = await jobDeClassificar(c);
    await handlerCom(jev.deps)(job, pool, { workerId: WORKER });
    await completeJob(pool, job.id, WORKER);
    await assentar();
    expect(jev.pedidos).toEqual([]);
    expect(await observacoes(c.org)).toEqual([]);
    expect(await chamadasDoJev(c.org)).toEqual([]);
    // Controle: a IA de sempre leu a transcrição e o passo andou.
    expect(await noAtual(c.enrollmentId)).toMatchObject({ current_node_id: "e_quer" });
  });
});
