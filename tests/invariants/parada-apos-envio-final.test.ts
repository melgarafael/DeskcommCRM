import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as AgentConfig from "@/lib/agent-engine/agent/agent-config";
import type * as Preview from "@/lib/agent-engine/agent/preview";
import { replyFixture } from "../support/autonomia-fixture";
import { seedGov } from "./gov-helpers";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O TURNO INTEIRO, CONTRA POSTGRES DE VERDADE: a parada do laço depois do envio
 * final declarado (knob AGENT_STOP_AFTER_FINAL_SEND) economiza o passo que só
 * dizia "terminei" — e NUNCA o passo que ainda tinha trabalho.
 *
 * O caso que dá nome ao arquivo é o (ii). Com `cases_enabled=false` (o padrão do
 * clone) a promessa "vou chamar alguém da equipe" passa pela cadeia, e a ordem
 * que o produto prescreve é avisar ANTES e só então chamar `request_human_handoff`.
 * Se o modelo marcar esse aviso como final, só a TRAVA impede que o cliente ouça
 * que vai falar com uma pessoa e ninguém seja acionado.
 *
 * Harness de `handoff-avisa-o-lead.test.ts` e `limite-de-envios-por-turno.test.ts`:
 * `createInboundTurnHandler` real, canal que CAPTURA, modelo fake roteirizado,
 * relógio fixo dentro da janela anti-ban e `sleep` no-op. O modelo conta só as
 * chamadas COM ferramentas — as do laço; o fechamento (checkpoint) vai sem elas.
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

const ORG = "b7b70000-0000-4000-8000-000000000001";
const CONTACT = "b7b70000-0000-4000-8000-000000000002";
const SESSION = "b7b70000-0000-4000-8000-000000000003";
const CONV = "b7b70000-0000-4000-8000-000000000004";
// Sessão com agente publicado `cases_enabled=true`, para o (iii-b). A base fica sem agente.
const SESSION_CASOS = "b7b70000-0000-4000-8000-000000000005";
const AGENT_CASOS = "b7b70000-0000-4000-8000-000000000006";
const VERSION_CASOS = "b7b70000-0000-4000-8000-000000000007";
const CONV_CASOS = "b7b70000-0000-4000-8000-000000000008";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  runAgentPreview: typeof InboundTurn.runAgentPreview;
  loadAgentVersionConfig: typeof AgentConfig.loadAgentVersionConfig;
  preview: typeof Preview;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

const texto = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const chamar = (toolName: string, input: Record<string, unknown>) => ({
  content: [
    { type: "tool-call" as const, toolCallId: `c-${crypto.randomUUID()}`, toolName, input: JSON.stringify(input) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const enviarFinal = (body: string) => chamar("send_message", { body, encerra_turno: true });

type Resposta = ReturnType<typeof texto> | ReturnType<typeof chamar>;

let enviados: string[] = [];
let chamadasComFerramentas = 0;
/** As PROPRIEDADES do JSON schema do `send_message` que o modelo viu, por chamada. */
let camposDoEnvio: string[][] = [];

/**
 * Modelo roteirizado: a N-ésima chamada COM ferramentas recebe `roteiro[N-1]`;
 * esgotado o roteiro, encerra com texto. Chamada SEM ferramentas (fechamento,
 * auxiliares) recebe o checkpoint.
 */
function modelo(roteiro: Resposta[]) {
  return async (opts: { tools?: Array<{ name?: string; inputSchema?: unknown }> }) => {
    const tools = opts.tools ?? [];
    if (tools.length === 0) return texto(CHECKPOINT);
    const envio = tools.find((t) => t.name === "send_message");
    const props = (envio?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    camposDoEnvio.push(Object.keys(props ?? {}));
    chamadasComFerramentas += 1;
    return roteiro[chamadasComFerramentas - 1] ?? texto("fim");
  };
}

type Modo = "off" | "observe" | "on";

/** Grava um inbound e roda UM turno completo; devolve o id do job. */
async function turno(
  roteiro: Resposta[],
  modo: Modo | undefined,
  onde: { sessao: string; conversa: string } = { sessao: SESSION, conversa: CONV },
): Promise<string> {
  const msgId = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device', now())`,
    [msgId, ORG, onde.conversa, onde.sessao, CONTACT, "bom dia, qual o horário de vocês?"],
  );
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: onde.conversa,
      contact_id: CONTACT,
      channel_session_id: onde.sessao,
      inbound_message_id: msgId,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "parada", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  const handler = m.createInboundTurnHandler(deps(roteiro, modo));
  try {
    await handler(claimed!, pool, { workerId: "parada" });
    await m.queue.completeJob(pool, claimed!.id, "parada");
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "parada", err);
    throw err;
  }
  return job.id;
}

function deps(roteiro: Resposta[], modo: Modo | undefined): InboundTurn.InboundTurnDeps {
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
      // Janela do `schedule_followup`: sem ela a ferramenta nem é oferecida.
      followup: { minAheadMs: 60_000, maxAheadMs: 30 * 86_400_000, staggerWindowMs: 0 },
      ...(modo !== undefined ? { paradaAposEnvioFinal: modo } : {}),
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(modelo(roteiro) as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push(i.body);
          return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Terça, 15h BRT: dentro da janela anti-ban — sem isto o `pacing` vetaria.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  };
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    runAgentPreview: (await import("@/lib/agent-engine/agent/inbound-turn")).runAgentPreview,
    loadAgentVersionConfig: (await import("@/lib/agent-engine/agent/agent-config")).loadAgentVersionConfig,
    preview: await import("@/lib/agent-engine/agent/preview"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'parada-apos-envio','Parada Após Envio','Parada Após Envio') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'parada-apos-envio-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'parada-apos-envio-casos-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1, $2, 'Agente da parada com casos', 'system') on conflict (id) do nothing`,
    [AGENT_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, cases_enabled)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published', true)
     on conflict (id) do nothing`,
    [VERSION_CASOS, ORG, AGENT_CASOS, SESSION_CASOS],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [VERSION_CASOS, AGENT_CASOS]);
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
  enviados = [];
  chamadasComFerramentas = 0;
  camposDoEnvio = [];
  // `force_human` é irrevogável e o `spinning` veta corpo repetido entre turnos:
  // cada caso começa do zero.
  for (const tabela of [
    "messages",
    "send_ledger",
    "outbound_copies",
    "agent_inbox_items",
    "cron_jobs",
    "job_queue",
    "conversations",
    "contacts",
  ]) {
    await pool.query(`delete from ${tabela} where organization_id = $1`, [ORG]);
  }
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number, force_human)
     values ($1,$2,'Cliente da parada','+5511900000888', false)`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("knob 'on' — o laço para depois do envio final declarado", () => {
  it("(i) envio neutro marcado: UMA chamada do laço, e o turno fecha normalmente", async () => {
    const jobId = await turno(
      [enviarFinal("Funcionamos de segunda a sexta, das 9h às 18h (caso i)."), texto("fim")],
      "on",
    );

    expect(chamadasComFerramentas, "o modelo foi chamado de novo só para encerrar").toBe(1);
    expect(enviados).toHaveLength(1);
    expect(camposDoEnvio[0]).toContain("encerra_turno");
    // "Fecha normalmente" = o fechamento (chamada SEM ferramentas) rodou e gravou
    // o checkpoint deste job, com o texto que o modelo fake devolveu a ela.
    const checkpoint = await pool.query<{ rolling_summary: string }>(
      "select rolling_summary from lead_checkpoints where job_id = $1",
      [jobId],
    );
    expect(checkpoint.rows.map((r) => r.rolling_summary)).toEqual(["turno de teste"]);
    const trace = await pool.query<{ status: string; messages_sent: number }>(
      "select status, messages_sent from agent_turn_traces where job_id = $1",
      [jobId],
    );
    expect(trace.rows).toEqual([{ status: "completed", messages_sent: 1 }]);
  });

  it("(iv) a correção do turno mudo usa a MESMA parada", async () => {
    await turno(
      [
        texto("Funcionamos de segunda a sexta."), // texto solto: o turno mudo pede correção
        enviarFinal("Funcionamos de segunda a sexta, das 9h às 18h (caso iv)."),
        texto("fim"),
      ],
      "on",
    );

    expect(enviados).toHaveLength(1);
    expect(chamadasComFerramentas, "principal + correção, sem o passo de encerrar").toBe(2);
  });
});

describe("knob 'on' — a TRAVA: envio que anuncia ação que falta não para o laço", () => {
  it("(ii) ⭐ 'vou chamar alguém da equipe' marcado como final: a passagem ACONTECE", async () => {
    await turno(
      [
        enviarFinal("Vou chamar alguém da equipe para te atender (caso ii)."),
        chamar("request_human_handoff", {
          motivo_codigo: "requested_human",
          por_que: "o cliente quer falar com uma pessoa",
        }),
        texto("fim"),
      ],
      "on",
    );

    const { rows } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where id = $1",
      [CONTACT],
    );
    expect(rows[0]!.force_human, "o cliente ouviu que vai falar com alguém e ninguém foi acionado").toBe(true);
    const inbox = await pool.query(
      "select 1 from agent_inbox_items where organization_id = $1 and kind = 'handoff'",
      [ORG],
    );
    expect(inbox.rows).toHaveLength(1);
    expect(chamadasComFerramentas).toBe(3);
    // Só a fala do modelo: com ela antes da passagem (seq > 0) o piso não fala.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain("Vou chamar alguém da equipe");
  });

  it("(ii-b) a promessa num passo ANTERIOR, sem marca, também segura: a passagem ACONTECE", async () => {
    // O modelo manda 2-4 mensagens seguidas: a promessa sai no passo 1 sem marca,
    // e é a mensagem neutra do passo 2 que ele marca como final.
    await turno(
      [
        chamar("send_message", { body: "Vou chamar alguém da equipe para te atender (caso ii-b)." }),
        enviarFinal("Enquanto isso, me conta o número do seu pedido?"),
        chamar("request_human_handoff", {
          motivo_codigo: "requested_human",
          por_que: "o cliente quer falar com uma pessoa",
        }),
        texto("fim"),
      ],
      "on",
    );

    const { rows } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where id = $1",
      [CONTACT],
    );
    expect(rows[0]!.force_human, "a promessa do passo 1 ficou sem a passagem").toBe(true);
    expect(chamadasComFerramentas).toBe(4);
    expect(enviados).toHaveLength(2);
  });

  it("(iii) 'te chamo amanhã às 10h' marcado como final: o follow-up é AGENDADO", async () => {
    await turno(
      [
        enviarFinal("Combinado, te chamo amanhã às 10h (caso iii)."),
        chamar("schedule_followup", {
          reason: "cliente pediu retorno amanhã",
          promised_at: "2026-07-29T13:00:00Z",
          promise: "chamar o cliente amanhã às 10h",
        }),
        texto("fim"),
      ],
      "on",
    );

    const { rows } = await pool.query(
      `select 1 from cron_jobs where organization_id = $1 and contact_id = $2 and job_kind = 'followup_turn'`,
      [ORG, CONTACT],
    );
    expect(rows, "o cliente ouviu 'te chamo amanhã' e nenhum retorno foi marcado").toHaveLength(1);
    // Desde o #2916 (main) a cadeia de envio veta, com os casos desligados, a
    // promessa de retorno que sai ANTES de `schedule_followup`
    // (`followup_promise_without_followup`): o envio do passo 1 não chega ao
    // cliente e o laço segue de qualquer jeito. Agendado o retorno, o modelo
    // encerra em texto sem ter mandado nada, e o turno mudo ganha a UMA
    // correção de sempre — a 4ª chamada. A trava não é o que segura este caso.
    expect(enviados, "a promessa antes do agendamento passou pela cadeia").toHaveLength(0);
    expect(chamadasComFerramentas).toBe(4);
  });

  it("(iii-b) ⭐ casos ligados e um caso JÁ aberto: só a trava faz o follow-up ser AGENDADO", async () => {
    // Com `cases_enabled=true` o veto de retorno da cadeia fica de fora, e o caso
    // aberto ANTES do turno libera o `casePromiseGate` (`hasOpenCase`): a promessa
    // sai. A trava não conta esse caso (`casoAbertoNesteTurno` é só o deste turno),
    // então é o ramo de RETORNO dela que impede o laço de parar aqui.
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'ai_handling',false)`,
      [CONV_CASOS, ORG, CONTACT, SESSION_CASOS],
    );
    await pool.query(
      `insert into agent_cases (organization_id, conversation_id, status, title, summary, blocker)
       values ($1,$2,'awaiting_human','Cobrança em dobro','cliente cobrado duas vezes','estorno é da equipe')`,
      [ORG, CONV_CASOS],
    );
    await turno(
      [
        enviarFinal("Combinado, te chamo amanhã às 10h (caso iii-b)."),
        chamar("schedule_followup", {
          reason: "cliente pediu retorno amanhã",
          promised_at: "2026-07-29T13:00:00Z",
          promise: "chamar o cliente amanhã às 10h",
        }),
        texto("fim"),
      ],
      "on",
      { sessao: SESSION_CASOS, conversa: CONV_CASOS },
    );

    const { rows } = await pool.query(
      `select 1 from cron_jobs where organization_id = $1 and contact_id = $2 and job_kind = 'followup_turn'`,
      [ORG, CONTACT],
    );
    expect(rows, "o cliente ouviu 'te chamo amanhã' e nenhum retorno foi marcado").toHaveLength(1);
    expect(enviados).toHaveLength(1);
    expect(chamadasComFerramentas).toBe(3);
  });
});

describe("knob 'observe' — expõe e registra, sem parar", () => {
  it("(v) o envio marcado não para o laço e o traço guarda a marca", async () => {
    const jobId = await turno(
      [enviarFinal("Funcionamos de segunda a sexta, das 9h às 18h (caso v)."), texto("fim")],
      "observe",
    );

    expect(chamadasComFerramentas).toBe(2);
    expect(camposDoEnvio[0]).toContain("encerra_turno");
    const { rows } = await pool.query<{ ferramentas: Array<Record<string, unknown>> }>(
      "select ferramentas from agent_turn_traces where job_id = $1",
      [jobId],
    );
    expect(rows[0]?.ferramentas[0]).toMatchObject({ nome: "send_message", estado: "ok", encerra_turno: true });
  });
});

describe("GUARDA — fora do inbound_turn de produção o 'on' não alcança", () => {
  it("prévia (sandbox) com 'on': o schema não ganha encerra_turno e o laço não para", async () => {
    seedGov();
    const f = await replyFixture(pool);
    const agent = await m.loadAgentVersionConfig(pool, f.org, f.agent, f.version);
    if (agent === null) throw new Error("a fixture não publicou o agente");
    await m.runAgentPreview(deps([enviarFinal("Funcionamos de segunda a sexta (prévia)."), texto("fim")], "on"), pool, {
      kind: "sandbox",
      organizationId: f.org,
      runId: crypto.randomUUID(),
      agent,
      contactId: null,
      channelId: f.channel,
      context: m.preview.scenarioContext([
        { direction: "inbound", body: "Qual o horário?", sent_at: "2026-07-28T17:59:00Z" },
      ]),
      result: m.preview.newPreviewResult(),
    });

    expect(camposDoEnvio[0]).toEqual(expect.arrayContaining(["body"]));
    expect(camposDoEnvio[0]).not.toContain("encerra_turno");
    expect(chamadasComFerramentas).toBe(2);
  });
});

describe("GUARDA — com o knob 'off' (o padrão do env) ou ausente, nada muda", () => {
  it.each<[string, Modo | undefined]>([
    ["'off'", "off"],
    ["ausente", undefined],
  ])(
    "knob %s: o schema do send_message não tem encerra_turno, o laço não para e o traço não ganha a chave",
    async (_rotulo, modo) => {
      // O modelo manda a marca mesmo assim: o schema de sempre a descarta.
      const jobId = await turno(
        [enviarFinal("Funcionamos de segunda a sexta, das 9h às 18h (guarda)."), texto("fim")],
        modo,
      );

      expect(camposDoEnvio[0]).toEqual(expect.arrayContaining(["body"]));
      expect(camposDoEnvio[0]).not.toContain("encerra_turno");
      expect(chamadasComFerramentas).toBe(2);
      expect(enviados).toHaveLength(1);
      const { rows } = await pool.query<{ ferramentas: Array<Record<string, unknown>> }>(
        "select ferramentas from agent_turn_traces where job_id = $1",
        [jobId],
      );
      expect(rows[0]?.ferramentas[0]).toEqual(expect.objectContaining({ nome: "send_message", estado: "ok" }));
      expect(rows[0]?.ferramentas[0]).not.toHaveProperty("encerra_turno");
    },
  );
});
