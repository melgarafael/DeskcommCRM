import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as TurnoJaRespondido from "@/lib/agent-engine/agent/turno-ja-respondido";
import type * as Drain from "@/lib/agent-engine/edge/crm/drain";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A RESPOSTA DESCARTADA TEM QUEM RESPONDA DEPOIS (#1940).
 *
 * `respostaFicouObsoleta` (lib/agent-engine/agent/turno-ja-respondido.ts) segura a
 * resposta de um turno quando o cliente escreve de novo enquanto o modelo pensa.
 * Isso só é seguro se a mensagem nova ganhar turno próprio: cliente sem resposta
 * é pior que resposta dupla. `turno-nao-responde-duas-vezes.test.ts` prova que a
 * resposta não sai; este arquivo prova que alguém responde depois — pelo caminho
 * de produção (evento `ai_agent.dispatch_requested` → drain → job `inbound_turn`),
 * não gravando a mensagem direto no banco.
 *
 * E o caso em que ninguém responderia: a mensagem reentregue com atraso chega
 * DEPOIS da leitura do turno, mas com o relógio do aparelho ANTERIOR à última
 * mensagem lida. O anti-backlog do drain ordena por esse relógio e pula o evento
 * dela como superado; se a régua descartasse a resposta por causa dela, o
 * cliente ficaria sem nenhuma.
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

const ORG = "eeb10000-0000-4000-8000-000000000001";
const CONTACT = "eeb10000-0000-4000-8000-000000000002";
const SESSION = "eeb10000-0000-4000-8000-000000000003";
const CONV = "eeb10000-0000-4000-8000-000000000004";

const TETO = 120_000;
const PERGUNTA = "Eu precisava comprar um pneu para a minha D01";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  regua: typeof TurnoJaRespondido;
  queue: typeof Queue;
  drainTick: typeof Drain.drainTick;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados = 0;

// A régua compara com `now()`, então os instantes são relativos ao relógio real.
const haSegundos = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

/**
 * `em` é quando a mensagem chegou a nós (`created_at`); `sentAt` é o relógio do
 * aparelho do cliente — iguais, salvo na mensagem reentregue com atraso.
 */
async function inbound(texto: string, em: string, sentAt = em): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',$8,$7)`,
    [id, ORG, CONV, SESSION, CONTACT, texto, em, sentAt],
  );
  return id;
}

/**
 * O caminho de produção da mensagem até um turno: a ingestão emite
 * `ai_agent.dispatch_requested` (`pedirDespachoDoAgente`, lib/channels/pos-entrada.ts)
 * e o drain o transforma em job — ou o pula (anti-backlog, portão de capacidade).
 *
 * O portão de capacidade só enfileira com agente publicado no número. O agente
 * sai logo depois do drain: os turnos seguem pelo mesmo caminho genérico de
 * `turno-nao-responde-duas-vezes.test.ts`, e é o drain — não o agente — que
 * está sob teste aqui.
 */
async function despacharPeloDrain(msgId: string): Promise<void> {
  const agente = crypto.randomUUID();
  const versao = crypto.randomUUID();
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent')`,
    [agente, ORG, `Agente resposta descartada ${agente}`],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [versao, ORG, agente, SESSION],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [versao, agente]);
  await pool.query(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     values ($1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
             jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                                'contact_id', $4::text, 'channel_session_id', $5::text,
                                'inbound_message_id', $2::text),
             'pending')`,
    [ORG, msgId, CONV, CONTACT, SESSION],
  );
  try {
    await m.drainTick(
      pool,
      { batchSize: 20, intervalMs: 100, idleIntervalMs: 100, debounceMs: 0, reapTimeoutMs: 300_000 },
      m.createLogger(),
    );
  } finally {
    await pool.query("delete from ai_agents where id = $1", [agente]);
  }
}

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Modelo fake: na 1ª chamada pede `send_message`; depois encerra. Com `chegada`,
 * a pergunta do cliente CHEGA nessa 1ª chamada — durante os 10–40 s do modelo,
 * como no caso medido — e é despachada pelo drain.
 */
function modelo(chegada: { sentAt?: string } | null) {
  let chamadas = 0;
  return async () => {
    chamadas += 1;
    if (chamadas === 1) {
      if (chegada !== null) {
        const agora = new Date().toISOString();
        await despacharPeloDrain(await inbound(PERGUNTA, agora, chegada.sentAt ?? agora));
      }
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "send_message",
            input: JSON.stringify({ body: "Tudo bem também! Como posso te ajudar?" }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" }),
        },
      ],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

/** Reivindica o próximo job da fila (tem de ser `jobId`) e o roda até o fim. */
async function rodarJob(jobId: string, fake: ReturnType<typeof modelo>): Promise<void> {
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "descartada", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      respostaObsoletaTetoMs: TETO,
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
    registry: m.createFakeRegistry(fake as never),
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
    // Dentro da janela anti-ban (7h-22h BRT), como os vizinhos.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
  await handler(claimed!, pool, { workerId: "descartada" });
  await m.queue.completeJob(pool, claimed!.id, "descartada");
}

/** O turno de "Tudo bem?", durante o qual a pergunta chega. */
async function turnoDuranteOQualAPerguntaChega(chegada: { sentAt?: string }): Promise<void> {
  await inbound("Oi", haSegundos(20));
  const msg = await inbound("Tudo bem?", haSegundos(15));
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
  await rodarJob(job.id, modelo(chegada));
}

/** Jobs de turno criados para a pergunta que chegou durante o turno. */
async function jobsDaPergunta(): Promise<Array<{ id: string; status: string }>> {
  const { rows } = await pool.query<{ id: string; status: string }>(
    `select j.id, j.status from job_queue j
       join messages msg on msg.id = (j.payload->>'inbound_message_id')::uuid
      where j.organization_id = $1 and j.kind = 'inbound_turn' and msg.body = $2`,
    [ORG, PERGUNTA],
  );
  return rows;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    regua: await import("@/lib/agent-engine/agent/turno-ja-respondido"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    drainTick: (await import("@/lib/agent-engine/edge/crm/drain")).drainTick,
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'resposta-descartada','Resposta Descartada','Resposta Descartada') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'resposta-descartada-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
  enviados = 0;
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Cliente de teste','+5511900000977')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

// Job deste arquivo que ficasse `running` travaria o `claimJobs` (vagas globais)
// dos arquivos seguintes.
afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});

describe("a resposta descartada tem quem responda depois", () => {
  it("descartada a resposta, a pergunta ganha o próprio turno e o cliente recebe uma resposta só", async () => {
    await turnoDuranteOQualAPerguntaChega({});
    expect(enviados).toBe(0);

    // A pergunta chegou com o turno anterior RODANDO: a coalescência só pega
    // carona em job pendente, então ela tem job próprio, atrás daquele.
    const jobs = await jobsDaPergunta();
    expect(jobs).toEqual([{ id: expect.any(String), status: "pending" }]);

    await rodarJob(jobs[0]!.id, modelo(null));
    expect(enviados).toBe(1);
  });

  it("régua: mensagem reentregue com atraso, mais velha pelo aparelho que a última lida, não é obsoleta", async () => {
    await inbound("Oi", haSegundos(40));
    await inbound("Tudo bem?", haSegundos(30));
    const job = crypto.randomUUID();
    await pool.query(
      `insert into job_queue (id, organization_id, contact_id, kind, payload, status, attempts)
       values ($1,$2,$3,'inbound_turn',$4,'done',1)`,
      [job, ORG, CONTACT, { conversation_id: CONV, ultima_inbound_vista_em: haSegundos(30) }],
    );
    // Chegou agora, mas o aparelho diz 35 s atrás.
    await inbound("mensagem atrasada", haSegundos(2), haSegundos(35));
    expect(
      await m.regua.respostaFicouObsoleta(
        pool,
        { organizationId: ORG, conversationId: CONV, jobId: job },
        TETO,
      ),
    ).toBe(false);
  });

  it("a reentregue com atraso, que o drain não vai atender, não segura a resposta", async () => {
    // "Oi" foi há 20 s e "Tudo bem?" há 15 s pelo aparelho; esta é de 17 s atrás.
    await turnoDuranteOQualAPerguntaChega({ sentAt: haSegundos(17) });

    expect(await jobsDaPergunta()).toEqual([]);
    expect(enviados).toBe(1);
  });
});
