import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A COMPOSIÇÃO DO PEDIDO CHEGA AO BANCO — pelo turno real (handler de
 * `inbound_turn`) e o Postgres do baseline (migration 9105).
 *
 * `llm_calls` só tinha totais, e o traço do turno gravava `historico_mensagens`
 * sempre nulo. Aqui o modelo é um dublê roteirizado em 2 passos (envio com 1000
 * tokens de entrada, depois o encerramento com 1100), e o que se mede é o que o
 * banco recebeu:
 *  - a linha `agent_turn` tem `passos=2`, `entrada_do_primeiro_passo=1000`,
 *    `input_tokens=2100`, tamanhos maiores que 0, nenhuma mídia e o hash;
 *  - o traço do turno grava a janela que de fato entrou na abertura;
 *  - um segundo turno do mesmo agente, sem prospecção, grava o MESMO prefixo.
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

const ORG = "c0905062-0000-4000-8000-000000000001";
const CONTACT = "c0905062-0000-4000-8000-000000000002";
const SESSION = "c0905062-0000-4000-8000-000000000003";
const CONV = "c0905062-0000-4000-8000-000000000004";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

const uso = (entrada: number) => ({
  inputTokens: { total: entrada, noCache: entrada, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
});
const enviar = (body: string, entrada: number) => ({
  content: [
    { type: "tool-call" as const, toolCallId: `c-${Math.random()}`, toolName: "send_message", input: JSON.stringify({ body }) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: uso(entrada),
  warnings: [],
});
const texto = (t: string, entrada: number) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: uso(entrada),
  warnings: [],
});
const FECHAMENTO = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" });

// Uma fala DIFERENTE por turno: a mesma cópia três vezes na organização é vetada
// pelo anti-spinning (`mass_identical`), e o veto puxa uma chamada de correção —
// outra linha `agent_turn` que não é o que este arquivo mede.
const FALAS = [
  "Oi! Já te ajudo.",
  "Claro, o plano anual sai mais em conta.",
  "Posso te mandar a tabela completa agora?",
  "Temos parcelamento em até doze vezes sem juros.",
  "Me conta de qual cidade você fala comigo.",
];
let falaDaVez = 0;

/** 2 passos do turno (1000 e 1100 de entrada) e, depois, o fechamento. */
function modelo() {
  const roteiro = [enviar(FALAS[falaDaVez++ % FALAS.length]!, 1000), texto("ok", 1100)];
  let n = 0;
  return async () => roteiro[n++] ?? texto(FECHAMENTO, 1);
}

async function semearMensagem(body: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
    [id, ORG, CONV, SESSION, CONTACT, body],
  );
  return id;
}

async function turno(): Promise<void> {
  // O turno anterior pode ter deixado job derivado na fila (follow-up, checkpoint):
  // o claim abaixo tem de pegar ESTE turno.
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  const msg = await semearMensagem("Quero saber o preço do plano anual");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "composicao", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  let enviados = 0;
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
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
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(modelo() as never),
    channel: () =>
      ({
        channel: "captura",
        send: async () => {
          enviados += 1;
          return { kind: "sent" as const, idempotencyKey: `k${enviados}`, messageId: `m${enviados}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
  await handler(claimed!, pool, { workerId: "composicao" });
  await m.queue.completeJob(pool, claimed!.id, "composicao");
}

interface LinhaDoTurno {
  passos: number | null;
  entrada_do_primeiro_passo: number | null;
  input_tokens: number;
  chars_sistema: number | null;
  chars_ferramentas: number | null;
  chars_mensagens: number | null;
  partes_de_midia: number | null;
  prefixo_hash: string | null;
}

async function linhasDoTurno(): Promise<LinhaDoTurno[]> {
  const { rows } = await pool.query<LinhaDoTurno>(
    `select passos, entrada_do_primeiro_passo, input_tokens, chars_sistema, chars_ferramentas,
            chars_mensagens, partes_de_midia, prefixo_hash
       from llm_calls where organization_id = $1 and purpose = 'agent_turn' order by created_at`,
    [ORG],
  );
  return rows;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'composicao-do-turno','Composição','Composição') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'composicao-do-turno-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
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
  for (const t of ["send_ledger", "llm_calls", "agent_turn_traces", "messages", "job_queue", "event_log", "conversations", "contacts"]) {
    await pool.query(`delete from ${t} where organization_id = $1`, [ORG]);
  }
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Cliente de teste','+5511900009062')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});

describe("o turno grava de que é feito o pedido", () => {
  it("a linha agent_turn tem passos, entrada do 1º passo e os tamanhos de cada parte", async () => {
    await semearMensagem("Oi, tudo bem?");
    await turno();

    const linhas = await linhasDoTurno();
    // Uma chamada só: o envio saiu, então não houve correção de turno mudo.
    expect(linhas).toHaveLength(1);
    const linha = linhas[0];
    expect(linha!.passos).toBe(2);
    expect(linha!.entrada_do_primeiro_passo).toBe(1000);
    // A soma dos passos segue sendo o total — a premissa que a coluna nova audita.
    expect(linha!.input_tokens).toBe(2100);
    expect(linha!.chars_sistema).toBeGreaterThan(0);
    expect(linha!.chars_ferramentas).toBeGreaterThan(0);
    expect(linha!.chars_mensagens).toBeGreaterThan(0);
    expect(linha!.partes_de_midia).toBe(0);
    expect(linha!.prefixo_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o traço do turno grava a janela que entrou na abertura, e não mais nulo", async () => {
    await semearMensagem("Oi, tudo bem?");
    await turno();

    const { rows } = await pool.query<{ historico_mensagens: number | null }>(
      `select historico_mensagens from agent_turn_traces where organization_id = $1`,
      [ORG],
    );
    expect(rows).toHaveLength(1);
    // As duas mensagens semeadas na conversa: a de antes e a que o turno responde.
    expect(rows[0]!.historico_mensagens).toBe(2);
  });

  it("dois turnos do mesmo agente, sem prospecção, gravam o MESMO prefixo", async () => {
    await turno();
    await turno();

    const linhas = await linhasDoTurno();
    expect(linhas).toHaveLength(2);
    expect(linhas[0]!.prefixo_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(linhas[1]!.prefixo_hash).toBe(linhas[0]!.prefixo_hash);
  });
});
