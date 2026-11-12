import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as ResolveTurnAgent from "@/lib/agent-engine/agent/resolve-turn-agent";

/**
 * O ADIAMENTO PELA JANELA NÃO TIRA A CONVERSA DO AGENTE DA CAMPANHA (#4024).
 *
 * ─── O defeito que este arquivo impede de voltar ────────────────────────────
 *
 * A primeira versão do degrau 0b da campanha de ENTRADA carimbava o próprio uso
 * num `update … set campaign_entry_agent_claimed_at = now() … returning` e valia
 * só no primeiro turno. Medido: o turno que o adiamento pegou gastava o carimbo
 * sem responder NADA, e a conversa — que nunca tinha sido atendida pelo agente da
 * campanha — voltava para o agente do número, que é exatamente o nicho errado
 * que a issue #4024 existe para consertar.
 *
 * A decisão do mantenedor (2026-11-05) é a mesma regra da campanha de SAÍDA: a
 * conversa em que a frase casou fica com o agente da campanha em TODO turno, e o
 * turno LÊ a coluna em vez de carimbar uso. Sem escrita não existe estado a
 * gastar, então o adiamento deixa de ter onde causar o defeito.
 *
 * ─── O que é medido, no Postgres de verdade ─────────────────────────────────
 *
 * 1. Relógio às 3h com a janela de resposta vazia (herda a de disparo): o turno é
 *    ADIADO (`fora da janela anti-ban`), nenhuma mensagem sai — e DEPOIS disso a
 *    conversa continua resolvendo para o agente da campanha.
 * 2. Um turno DENTRO da janela, depois do primeiro, ainda sai pelo agente da
 *    campanha: o turno responde e a resolução real devolve `outcome: campanha`
 *    com o `agentId` da campanha. É este caso que fica VERMELHO se o carimbo de
 *    uso único voltar (o segundo turno devolveria `null` e cairia no número).
 *
 * Harness copiado de `janela-de-resposta-no-turno.test.ts` (invariantes são
 * congelados: arquivo novo, nunca editar o vizinho), com ids próprios.
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

const ORG = "dddddddd-0000-4000-8000-0000000004b1";
const CONTACT = "dddddddd-0000-4000-8000-0000000004b2";
const SESSION = "dddddddd-0000-4000-8000-0000000004b3";
const CONV = "dddddddd-0000-4000-8000-0000000004b4";
const MSG = "dddddddd-0000-4000-8000-0000000004b5";
const CRM_EVENT = "dddddddd-0000-4000-8000-0000000004b6";
/** O agente que a campanha de entrada declara — publicado, com versão. */
const AGENTE_CAMPANHA = "dddddddd-0000-4000-8000-0000000004b7";
const VERSAO_CAMPANHA = "dddddddd-0000-4000-8000-0000000004b8";

/** Terça, 3h BRT — fora dela, com folga dos dois lados. */
const FORA_DA_JANELA = new Date("2026-07-28T06:00:00Z");

interface EnvioCapturado {
  body: string;
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  resolveTurnAgent: typeof ResolveTurnAgent.resolveTurnAgent;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];

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
 * Modelo fake que manda UMA mensagem e encerra. `rotulo` é único por turno: a
 * conversa é a mesma e o gate `spinning` veta corpo repetido entre turnos — sem
 * o rótulo, o segundo turno seria bloqueado por um motivo que não é o deste
 * arquivo.
 */
function modeloQueManda(rotulo: string) {
  let mandou = false;
  return async () => {
    if (!mandou) {
      mandou = true;
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "send_message",
            input: JSON.stringify({ body: `oi, tudo bem? (${rotulo})` }),
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

function montaHandler(doGenerate: unknown, instante: Date) {
  return m.createInboundTurnHandler({
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
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: EnvioCapturado) => {
          enviados.push(i);
          return {
            kind: "sent" as const,
            idempotencyKey: `k${enviados.length}`,
            messageId: `m${enviados.length}`,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // O ponto do arquivo: é ESTE instante que decide a janela, e não a hora em
    // que a suíte por acaso rodou.
    clock: () => instante,
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
      crm_event_id: CRM_EVENT,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "campanha", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "campanha" });
    await m.queue.completeJob(pool, claimed!.id, "campanha");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "campanha", err);
    return err as Error;
  }
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    resolveTurnAgent: (await import("@/lib/agent-engine/agent/resolve-turn-agent")).resolveTurnAgent,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'campanha-no-adiamento','Campanha no adiamento','Campanha no adiamento') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead do Anúncio','+5511900000778') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'campanha-no-adiamento-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  // O agente da campanha PRECISA ser publicado com versão: é o que
  // `loadPublishedAgentConfigById` exige para o degrau 0b vencer o número.
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1,$2,'Especialista do anúncio','system') on conflict (id) do nothing`,
    [AGENTE_CAMPANHA, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
     values ($1,$2,$3,1,'system','anthropic','claude-sonnet-4-6',$4,'published')
     on conflict (id) do nothing`,
    [VERSAO_CAMPANHA, ORG, AGENTE_CAMPANHA, SESSION],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [
    VERSAO_CAMPANHA,
    AGENTE_CAMPANHA,
  ]);
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group, campaign_entry_agent_id)
     values ($1,$2,$3,$4,'ai_handling',false,$5) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION, AGENTE_CAMPANHA],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Quero saber mais sobre implantes','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(() => {
  enviados = [];
});

async function janelaDeResposta(inicio: number | null, fim: number | null): Promise<void> {
  await pool.query(
    `insert into channel_knobs (organization_id, channel_session_id, resposta_start_hour, resposta_end_hour)
     values ($1, $2, $3, $4)
     on conflict (organization_id, channel_session_id)
     do update set resposta_start_hour = excluded.resposta_start_hour,
                   resposta_end_hour = excluded.resposta_end_hour`,
    [ORG, SESSION, inicio, fim],
  );
}

/** A resolução REAL contra o banco, como o turno a faz. */
async function resolucaoDoTurno() {
  return m.resolveTurnAgent(
    pool,
    {} as never,
    {
      tenantId: ORG,
      leadId: CONTACT,
      jobId: "00000000-0000-4000-8000-0000000004b9",
      channelSessionId: SESSION,
      conversationId: CONV,
      signal: "Quero saber mais sobre implantes",
      stickyAgentId: null,
      stickyIntent: null,
    },
    { log: m.createLogger() },
  );
}

describe("o adiamento não tira a conversa do agente da campanha (#4024)", () => {
  it("às 3h com a janela de resposta vazia o turno é ADIADO, nada sai, e a conversa SEGUE no agente da campanha", async () => {
    await janelaDeResposta(null, null);

    const erro = await rodaTurno(montaHandler(modeloQueManda("adiado"), FORA_DA_JANELA));

    expect(erro).not.toBeNull();
    expect(String(erro?.message)).toMatch(/fora da janela anti-ban/);
    expect(enviados).toHaveLength(0);

    // O coração do teste: o adiamento não pode tirar a conversa do agente da
    // campanha. Com o carimbo de uso único, este turno adiado o gastava.
    const resolucao = await resolucaoDoTurno();
    expect(resolucao.outcome, "a conversa saiu do agente da campanha no adiamento").toBe("campanha");
    expect(resolucao.config?.agentId).toBe(AGENTE_CAMPANHA);
  });

  it("um turno DENTRO da janela, depois do primeiro, ainda sai pelo agente da campanha", async () => {
    await janelaDeResposta(0, 24);

    const primeiro = await rodaTurno(montaHandler(modeloQueManda("dentro-1"), FORA_DA_JANELA));
    expect(primeiro).toBeNull();
    expect(enviados).toHaveLength(1);

    // O SEGUNDO turno da mesma conversa. Se o uso único voltar, o degrau devolve
    // `null` aqui e o turno cai no agente do número.
    const segundo = await rodaTurno(montaHandler(modeloQueManda("dentro-2"), FORA_DA_JANELA));
    expect(segundo).toBeNull();
    expect(enviados).toHaveLength(2);

    const resolucao = await resolucaoDoTurno();
    expect(resolucao.outcome, "o segundo turno voltou para a régua do número").toBe("campanha");
    expect(resolucao.config?.agentId).toBe(AGENTE_CAMPANHA);
    expect(resolucao.config?.versionId).toBe(VERSAO_CAMPANHA);
  });
});
