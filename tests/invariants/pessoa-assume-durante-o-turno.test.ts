import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A PESSOA ASSUME DEPOIS QUE O MODELO RESPONDEU — e a mensagem da IA não sai.
 *
 * O gate do começo do turno já barra a conversa que está com gente. O que sobra
 * é a janela entre a decisão de falar e a entrega: modelo, tools, digitação.
 * Aqui o modelo fake escreve no banco, no meio do turno, o que a tela grava
 * quando alguém assume, e só então pede `send_message`. Com handler real e
 * banco real:
 *
 *   - controle (ninguém assume): o canal recebe a mensagem — sem isto, "o canal
 *     não foi chamado" nos outros casos não mediria nada;
 *   - dono humano gravado no meio do turno (o rodízio e o "Assumir" atribuem):
 *     o canal NÃO é chamado, o modelo recebe `pessoa_assumiu_a_conversa`, e o
 *     turno termina sem erro (a fila não re-tenta);
 *   - silêncio permanente gravado no meio do turno: idem;
 *   - "IA com o dono" ligado: o dono não veta, a mensagem sai;
 *   - #5259: o PRÓPRIO turno transfere (`fn_conversation_assign` com o job dele):
 *     o aviso de transferência sai. Uma pessoa que troca o dono depois, ou que
 *     escreve na conversa, continua vetando.
 *
 * Harness igual a `falha-permanente-de-envio-no-turno.test.ts`.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "eeeeeeee-5157-4000-8000-000000000001";
const CONTACT = "eeeeeeee-5157-4000-8000-000000000002";
const SESSION = "eeeeeeee-5157-4000-8000-000000000003";
const CONV = "eeeeeeee-5157-4000-8000-000000000004";
const MSG = "eeeeeeee-5157-4000-8000-000000000005";
const PESSOA = "eeeeeeee-5157-4000-8000-000000000007";
const OUTRA_PESSOA = "eeeeeeee-5157-4000-8000-000000000008";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let chamadasAoCanal: Array<{ body: string }> = [];
let resultadosVistos: unknown[] = [];

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});
const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Modelo que, na PRIMEIRA chamada, roda `noMeio` (a pessoa assumindo) e pede um
 * `send_message`; na seguinte, fecha. `rotulo` único por teste (trava de repetição).
 */
function modeloQueResponde(rotulo: string, noMeio: () => Promise<void>) {
  let chamadas = 0;
  return async (opts: { prompt?: unknown }) => {
    for (const msg of (opts.prompt ?? []) as Array<{ content?: unknown }>) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") resultadosVistos.push(parte.output ?? parte);
      }
    }
    chamadas += 1;
    if (chamadas === 1) {
      await noMeio();
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "send_message",
            input: JSON.stringify({ body: `resposta da IA (${rotulo})` }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [{ type: "text" as const, text: CHECKPOINT }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

function montaHandler(doGenerate: unknown) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      maxSendsPerTurn: 5,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          chamadasAoCanal.push(i);
          const n = chamadasAoCanal.length;
          return { kind: "sent" as const, idempotencyKey: `k${n}`, messageId: `m${n}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

async function rodaTurno(handler: ReturnType<typeof montaHandler>): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: "eeeeeeee-5157-4000-8000-000000000006",
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "pessoa-assume", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "pessoa-assume" });
    await m.queue.completeJob(pool, claimed!.id, "pessoa-assume");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "pessoa-assume", err);
    return err as Error;
  }
}

/** O que a tela grava quando alguém assume (o CHECK de coerência exige os dois). */
const pessoaAssume = async () => {
  await pool.query(
    `update conversations set assigned_to_user_id = $3, assignee_kind = 'user'
      where organization_id = $1 and id = $2`,
    [ORG, CONV, PESSOA],
  );
};
/** O job do turno em execução — o mesmo que o runtime injeta como `sourceJobId`. */
const jobEmExecucao = async (): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>(
    `select id from job_queue where organization_id = $1 and status = 'running'`,
    [ORG],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
};
/** O que `crm_assign_conversation` faz no turno: a RPC real, com o job de origem. */
const oTurnoTransfere = async () => {
  await pool.query(
    `select public.fn_conversation_assign($1, $2, $3, 'transfer', null, false, $4)`,
    [ORG, CONV, PESSOA, await jobEmExecucao()],
  );
};
const silencioPermanente = async () => {
  await pool.query(
    `update conversations set bot_silenced_until = 'infinity' where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
};

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into auth.users (id, email) values ($1, 'pessoa-assume-no-turno@invariant.test') on conflict (id) do nothing`,
    [PESSOA],
  );
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'outra-pessoa-assume-no-turno@invariant.test') on conflict (id) do nothing`,
    [OUTRA_PESSOA],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'pessoa-assume-no-turno','Pessoa Assume','Pessoa Assume') on conflict (id) do nothing`,
    [ORG],
  );
  // `fn_conversation_assign` só atribui a membro ativo (agent+) da organização.
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at)
     values ($1, $3, 'agent', now()), ($2, $3, 'agent', now())
     on conflict (user_id, organization_id) do nothing`,
    [PESSOA, OUTRA_PESSOA, ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead do Turno','+5511900005157') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pessoa-assume-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  chamadasAoCanal = [];
  resultadosVistos = [];
  // Cada caso começa com a conversa livre, com a IA atendendo.
  await pool.query(
    `update conversations
        set assigned_to_user_id = null, assignee_kind = 'ai', bot_silenced_until = null,
            status = 'ai_handling', metadata = '{}'::jsonb
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
});

describe("turno completo — uma pessoa assume entre a resposta do modelo e o envio", () => {
  it("controle: ninguém assume, a mensagem da IA chega ao canal", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueResponde("controle", async () => {})));

    expect(erro).toBeNull();
    expect(chamadasAoCanal).toHaveLength(1);
  });

  it("⭐ dono humano gravado no meio do turno: nada sai, o modelo é avisado e a fila não re-tenta", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueResponde("dono", pessoaAssume)));

    expect(erro, "o turno lançou — a fila vai re-rodá-lo").toBeNull();
    expect(chamadasAoCanal, "a IA falou por cima de quem assumiu").toHaveLength(0);
    expect(JSON.stringify(resultadosVistos)).toMatch(/pessoa_assumiu_a_conversa/);
  });

  it("silêncio permanente gravado no meio do turno: nada sai", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueResponde("silencio", silencioPermanente)));

    expect(erro).toBeNull();
    expect(chamadasAoCanal).toHaveLength(0);
  });

  it("'IA com o dono' ligado: o dono não veta, a mensagem sai", async () => {
    await pool.query(
      `update conversations set metadata = '{"ai_com_dono": true}'::jsonb where organization_id = $1 and id = $2`,
      [ORG, CONV],
    );
    const erro = await rodaTurno(montaHandler(modeloQueResponde("ia-com-dono", pessoaAssume)));

    expect(erro).toBeNull();
    expect(chamadasAoCanal).toHaveLength(1);
  });
});

describe("#5259 — o próprio turno transfere a conversa e avisa o cliente", () => {
  it("⭐ o agente atribui no turno: o aviso de transferência chega ao canal", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueResponde("transfere", oTurnoTransfere)));

    expect(erro).toBeNull();
    expect(JSON.stringify(resultadosVistos)).not.toMatch(/pessoa_assumiu_a_conversa/);
    expect(chamadasAoCanal, "o aviso de transferência do próprio turno foi barrado").toHaveLength(1);
  });

  it("o agente atribui e uma PESSOA troca o dono depois: nada sai", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloQueResponde("transfere-e-pessoa-troca", async () => {
          await oTurnoTransfere();
          // Outro ator: sem job de origem, como a tela e o rodízio atribuem.
          await pool.query(`select public.fn_conversation_assign($1, $2, $3, 'transfer', null, false)`, [
            ORG,
            CONV,
            OUTRA_PESSOA,
          ]);
        }),
      ),
    );

    expect(chamadasAoCanal, "a IA falou por cima de quem assumiu").toHaveLength(0);
    expect(JSON.stringify(resultadosVistos)).toMatch(/pessoa_assumiu_a_conversa/);
    // A atribuição da pessoa (sem job de origem) revoga o turno vivo pelo
    // `trg_interromper_turnos_ao_assumir` (#3926): o complete perde o lease e
    // o job fica `failed`, sem nova tentativa — a fila não re-roda o turno.
    expect(erro?.message ?? "").toMatch(/perdido no complete/);
    const { rows } = await pool.query<{ status: string; last_error: string | null }>(
      `select status, last_error from job_queue
        where organization_id = $1 and kind = 'inbound_turn'
        order by created_at desc limit 1`,
      [ORG],
    );
    expect(rows[0]).toMatchObject({ status: "failed", last_error: "conversation_command_taken" });
  });

  it("o agente atribui e o atendente já escreveu ao cliente: nada sai", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloQueResponde("transfere-e-pessoa-escreve", async () => {
          await oTurnoTransfere();
          await pool.query(
            `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
               type, direction, status, body, sent_via, sent_by_user_id, sent_at)
             values ($1,$2,$3,$4,'text','outbound','sent','Oi, aqui é a atendente','crm',$5, now())`,
            [ORG, CONV, SESSION, CONTACT, PESSOA],
          );
        }),
      ),
    );

    expect(erro).toBeNull();
    expect(chamadasAoCanal, "a IA falou por cima da atendente").toHaveLength(0);
  });
});
