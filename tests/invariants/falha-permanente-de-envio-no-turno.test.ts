import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O TURNO COMPLETO quando o canal recusa o envio.
 *
 * Medido ao vivo (15/11/2026): o provedor de uma rede social recusou com 400 a
 * resposta da IA, e a fila re-rodou o turno várias vezes — cada volta deixou
 * mais um balão vermelho na conversa. Aqui, com o handler real, banco real e
 * modelo fake que INSISTE em mandar:
 *
 *   - recusa definitiva (`permanente`): o turno termina SEM erro (a fila não
 *     re-tenta), o canal é chamado UMA vez só (as insistências do modelo nem
 *     chegam a ele), o modelo é avisado para encerrar, e a equipe recebe UM
 *     aviso na Central para a conversa;
 *   - falha transitória (5xx/rede): o turno lança "re-tentado pela fila", como
 *     sempre, e não há aviso.
 *
 * Harness igual a `limite-de-envios-por-turno.test.ts`.
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

const ORG = "eeeeeeee-4700-4000-8000-000000000001";
const CONTACT = "eeeeeeee-4700-4000-8000-000000000002";
const SESSION = "eeeeeeee-4700-4000-8000-000000000003";
const CONV = "eeeeeeee-4700-4000-8000-000000000004";
const MSG = "eeeeeeee-4700-4000-8000-000000000005";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  titulo: string;
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

/** Modelo que chama `send_message` `n` vezes e só então fecha. `rotulo` único por teste (trava de repetição). */
function modeloQueInsiste(n: number, rotulo: string) {
  let chamadas = 0;
  return async (opts: { prompt?: unknown }) => {
    for (const msg of (opts.prompt ?? []) as Array<{ content?: unknown }>) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") resultadosVistos.push(parte.output ?? parte);
      }
    }
    if (chamadas < n) {
      chamadas += 1;
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `c${chamadas}`,
            toolName: "send_message",
            input: JSON.stringify({ body: `resposta ${chamadas} (${rotulo})` }),
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

function montaHandler(doGenerate: unknown, permanente: boolean) {
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
        channel: "recusa",
        send: async (i: { body: string }) => {
          chamadasAoCanal.push(i);
          const n = chamadasAoCanal.length;
          return { kind: "failed" as const, idempotencyKey: `k${n}`, messageId: `m${n}`, permanente };
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
      crm_event_id: "eeeeeeee-4700-4000-8000-000000000006",
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "falha-permanente", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "falha-permanente" });
    await m.queue.completeJob(pool, claimed!.id, "falha-permanente");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "falha-permanente", err);
    return err as Error;
  }
}

async function avisosAbertos(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from agent_inbox_items
      where organization_id = $1 and status = 'open' and ref_kind = 'conversation' and ref_id = $2 and title = $3`,
    [ORG, CONV, m.titulo],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    titulo: (await import("@/lib/agent-engine/agent/falha-permanente-de-envio")).TITULO_DO_AVISO_DE_FALHA_PERMANENTE,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'falha-permanente-turno','Falha Permanente','Falha Permanente') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Recusado','+5511900004700') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'falha-permanente-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
});

describe("turno completo — o canal recusa o envio", () => {
  it("⭐ recusa definitiva: sem retry, uma chamada ao canal, modelo avisado, um aviso na Central", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueInsiste(3, "permanente-a"), true));

    expect(erro, "o turno lançou — a fila vai re-rodá-lo e mandar de novo").toBeNull();
    expect(chamadasAoCanal, "as insistências do modelo chegaram ao canal que já recusou").toHaveLength(1);
    expect(JSON.stringify(resultadosVistos)).toMatch(/envio_recusado_pelo_canal/);
    expect(await avisosAbertos()).toBe(1);
  });

  it("a segunda recusa na mesma conversa cai no MESMO aviso aberto", async () => {
    expect(await rodaTurno(montaHandler(modeloQueInsiste(1, "permanente-b"), true))).toBeNull();
    expect(await rodaTurno(montaHandler(modeloQueInsiste(1, "permanente-c"), true))).toBeNull();
    expect(await avisosAbertos()).toBe(1);
  });

  it("falha transitória (5xx/rede): o turno lança e a fila re-tenta, como sempre — sem aviso", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueInsiste(1, "transitoria-a"), false));

    expect(erro?.message).toMatch(/re-tentado pela fila/);
    expect(chamadasAoCanal).toHaveLength(1);
    expect(await avisosAbertos()).toBe(0);
  });
});
