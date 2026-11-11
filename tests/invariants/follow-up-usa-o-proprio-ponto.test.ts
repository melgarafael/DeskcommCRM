import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as FollowupTurn from "@/lib/agent-engine/agent/followup-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as Fronteira from "@/lib/atendimento/fronteira-server";

/**
 * O FOLLOW-UP CHAMA O MODELO PELO PRÓPRIO PONTO — e a resposta ao cliente não.
 *
 * ─── Por que o ponto existe ─────────────────────────────────────────────────
 *
 * O mesmo turno do agente roda em dois kinds de job: `inbound_turn` (responde
 * quem escreveu, operando o CRM) e `followup_turn` (retoma quem parou de
 * responder). Medido numa instalação real (30/09–02/10/2026), os follow-ups
 * eram 31% do gasto do agente; um modelo barato escreve bem a retomada e não
 * opera o CRM. O ponto `followup_turn` deixa o painel trocar o modelo SÓ ali.
 *
 * ─── O que este arquivo guarda que os unitários não guardam ────────────────
 *
 * `tests/unit/modelo-do-follow-up.test.ts` prova o seam com o `purpose` já
 * escolhido. Quem ESCOLHE o `purpose` é `executarTurnoDoAgente`, pelo `kind` do
 * job — e trocar aquela linha de volta para `'agent_turn'` deixaria todos os
 * unitários verdes. Aqui rodam os handlers REAIS dos dois kinds (modelo dublê,
 * canal que captura), com agente publicado e binding no banco de verdade, e a
 * prova é lida de `llm_calls` — a mesma tabela que a tela de Execuções e a
 * consulta de custo por `purpose` leem.
 *
 * Harness de `o-turno-diz-ao-modelo-que-dia-e-hoje.test.ts`, com agente
 * publicado no número (o modelo da versão é o que "sem escolha" tem de manter)
 * e o caminho de retorno combinado do follow-up (`schedule_followup`, sem
 * enrollment) — o turno é o MESMO núcleo do passo de IA dos fluxos.
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

const ORG = "eeeeeeee-0000-4000-8000-0000000000f1";
const CONTACT = "eeeeeeee-0000-4000-8000-0000000000f2";
const SESSION = "eeeeeeee-0000-4000-8000-0000000000f3";
const CONV = "eeeeeeee-0000-4000-8000-0000000000f4";
const AGENT = "eeeeeeee-0000-4000-8000-0000000000f5";
const VERSION = "eeeeeeee-0000-4000-8000-0000000000f6";

const MODELO_DO_AGENTE = "claude-do-agente-publicado";
const MODELO_DO_FOLLOWUP = "claude-barato-do-follow-up";

/** Sexta, 14:30 em São Paulo — dentro da janela anti-ban de disparo (7h-22h). */
const INSTANTE = new Date("2026-09-04T17:30:00Z");

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  createFollowupTurnHandler: typeof FollowupTurn.createFollowupTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  readCurrentServiceBoundary: typeof Fronteira.readCurrentServiceBoundary;
};
let m: Modules;

let enviados: Array<{ body: string }> = [];

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

/** Manda UMA mensagem e fecha com o checkpoint — o turno mais curto que existe. */
function modeloQueMandaUmaMensagem(texto: string) {
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
            input: JSON.stringify({ body: texto }),
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

function deps(texto: string) {
  return {
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
    registry: m.createFakeRegistry(modeloQueMandaUmaMensagem(texto) as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push(i);
          return {
            kind: "sent" as const,
            idempotencyKey: `k${enviados.length}-${Date.now()}`,
            messageId: `m${enviados.length}-${Date.now()}`,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => INSTANTE,
    sleep: async () => {},
  };
}

/** Uma mensagem NOVA do cliente — cada turno de resposta precisa da sua. */
async function inboundNovo(texto: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device', now())`,
    [id, ORG, CONV, SESSION, CONTACT, texto],
  );
  return id;
}

async function rodar(
  kind: "inbound_turn" | "followup_turn",
  payload: Record<string, unknown>,
  texto: string,
): Promise<{ jobId: string; erro: Error | null }> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, { kind, leadId: CONTACT, payload, maxAttempts: 1 });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "seguimento", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  const handler =
    kind === "inbound_turn"
      ? m.createInboundTurnHandler(deps(texto) as never)
      : m.createFollowupTurnHandler(deps(texto) as never);
  try {
    await handler(claimed!, pool, { workerId: "seguimento" });
    await m.queue.completeJob(pool, claimed!.id, "seguimento");
    return { jobId: job.id, erro: null };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "seguimento", err);
    return { jobId: job.id, erro: err as Error };
  }
}

async function responder(): Promise<{ jobId: string; erro: Error | null }> {
  const msg = await inboundNovo(`pergunta ${crypto.randomUUID().slice(0, 6)}`);
  return rodar(
    "inbound_turn",
    {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    `resposta ${crypto.randomUUID().slice(0, 6)}`,
  );
}

async function retomar(): Promise<{ jobId: string; erro: Error | null }> {
  const fronteira = await m.readCurrentServiceBoundary(pool, ORG, CONV);
  expect(fronteira, "a conversa do teste não tem fronteira de atendimento").not.toBeNull();
  return rodar(
    "followup_turn",
    { service_boundary: fronteira, reason: "o cliente parou de responder" },
    `retomada ${crypto.randomUUID().slice(0, 6)}`,
  );
}

/** A chamada PRINCIPAL do job — a de fechamento (`checkpoint`) fica de fora. */
async function chamadaPrincipal(jobId: string) {
  const { rows } = await pool.query<{ purpose: string; model: string; origem_da_escolha: string; agent_id: string | null }>(
    `select purpose, model, origem_da_escolha, agent_id from llm_calls
      where organization_id = $1 and job_id = $2 and purpose <> 'checkpoint'
      order by created_at`,
    [ORG, jobId],
  );
  return rows;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    createFollowupTurnHandler: (await import("@/lib/agent-engine/agent/followup-turn")).createFollowupTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    readCurrentServiceBoundary: (await import("@/lib/atendimento/fronteira-server")).readCurrentServiceBoundary,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'seguimento-proprio','Seguimento Proprio','Seguimento Proprio') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead do Seguimento','+5511900000888') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'seguimento-proprio-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
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
  // O agente publicado no número: o modelo da versão é o que "sem escolha" mantém.
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, 'Vendedor do teste', 'você é um vendedor', 'mcp_agent') on conflict (id) do nothing`,
    [AGENT, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um vendedor', 'anthropic', $4, $5, 'published', now())
     on conflict (id) do nothing`,
    [VERSION, ORG, AGENT, MODELO_DO_AGENTE, SESSION],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [VERSION, AGENT]);
});

beforeEach(async () => {
  enviados = [];
  await pool.query(`delete from ai_purpose_bindings where organization_id = $1`, [ORG]);
});

describe("o follow-up chama o modelo como `followup_turn`; a resposta, como `agent_turn`", () => {
  it("sem escolha no painel: o follow-up usa o modelo da versão publicada — nada muda", async () => {
    const resposta = await responder();
    expect(resposta.erro).toBeNull();
    expect(await chamadaPrincipal(resposta.jobId)).toEqual([
      { purpose: "agent_turn", model: MODELO_DO_AGENTE, origem_da_escolha: "agente_publicado", agent_id: AGENT },
    ]);

    const retomada = await retomar();
    expect(retomada.erro).toBeNull();
    expect(await chamadaPrincipal(retomada.jobId)).toEqual([
      // O mesmo modelo e a mesma origem de antes do ponto existir — só o
      // `purpose` muda, e é ele que separa o custo do follow-up.
      { purpose: "followup_turn", model: MODELO_DO_AGENTE, origem_da_escolha: "agente_publicado", agent_id: AGENT },
    ]);
  });

  it("com escolha no painel: o follow-up troca de modelo, e a resposta ao cliente NÃO", async () => {
    await pool.query(
      `insert into ai_purpose_bindings (organization_id, purpose, provider, model_id, is_enabled)
       values ($1, 'followup_turn', 'anthropic', $2, true)`,
      [ORG, MODELO_DO_FOLLOWUP],
    );

    const retomada = await retomar();
    expect(retomada.erro).toBeNull();
    expect(await chamadaPrincipal(retomada.jobId)).toEqual([
      { purpose: "followup_turn", model: MODELO_DO_FOLLOWUP, origem_da_escolha: "binding", agent_id: AGENT },
    ]);
    // O follow-up SAIU — trocar o modelo não pode custar a mensagem.
    expect(enviados).toHaveLength(1);

    // Controle: com a escolha do follow-up gravada, a resposta segue no agente.
    const resposta = await responder();
    expect(resposta.erro).toBeNull();
    expect(await chamadaPrincipal(resposta.jobId)).toEqual([
      { purpose: "agent_turn", model: MODELO_DO_AGENTE, origem_da_escolha: "agente_publicado", agent_id: AGENT },
    ]);
  });

  it("escolha DESLIGADA no painel: o follow-up volta ao modelo da versão publicada", async () => {
    await pool.query(
      `insert into ai_purpose_bindings (organization_id, purpose, provider, model_id, is_enabled)
       values ($1, 'followup_turn', 'anthropic', $2, false)`,
      [ORG, MODELO_DO_FOLLOWUP],
    );
    const retomada = await retomar();
    expect(retomada.erro).toBeNull();
    expect(await chamadaPrincipal(retomada.jobId)).toEqual([
      { purpose: "followup_turn", model: MODELO_DO_AGENTE, origem_da_escolha: "agente_publicado", agent_id: AGENT },
    ]);
  });
});
