import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * TURNO MUDO — o turno de resposta que terminou sem mensagem ao cliente pede
 * UMA correção, pelo turno real (handler de `inbound_turn`) e o Postgres do
 * baseline.
 *
 * O caso medido (06/10/2026): o cliente mandou os dados de entrega, o agente
 * gravou o pedido e perguntou o sobrenome em TEXTO SOLTO — sem `send_message`.
 * `messages_sent: 0`, sem veto, sem descarte: o cliente ficou sem resposta.
 *
 * O modelo é um dublê roteirizado por chamada (mesmo desenho de
 * `resposta-descartada-tem-quem-responda.test.ts`); o que se mede é o motor:
 * - texto solto → a 2ª chamada leva a correção, o envio sai pela cadeia;
 * - controle: quem já enviou não recebe correção (nenhuma chamada a mais);
 * - quem insiste no silêncio recebe UMA correção, nunca um laço.
 *
 * #2938 — CASO HUMANO SÓ COM SINAL DE FALHA (decisão (b) do mantenedor): o
 * CORRECAO_DO_TURNO_MUDO autoriza o modelo a escolher o silêncio ("nada a
 * dizer"), então silêncio deliberado NÃO abre caso humano; abre quando a
 * SAÍDA veio truncada (length) ou quando a PRÓPRIA correção também truncou.
 * Esses três cenários rodam numa sessão com agente publicado e
 * `cases_enabled=true` (a coluna vem false por padrão e a régua
 * `casesEnabled` gateia o `openCase`), contando casos por conversa.
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

const ORG = "ee0d0601-0000-4000-8000-000000000001";
const CONTACT = "ee0d0601-0000-4000-8000-000000000002";
const SESSION = "ee0d0601-0000-4000-8000-000000000003";
const CONV = "ee0d0601-0000-4000-8000-000000000004";
// Sessão COM casos humanos ligados (agente publicado `cases_enabled=true`) — os
// cenários de falha medem se o caso abre; a sessão base fica sem agente nenhum.
const SESSION_CASOS = "ee0d0601-0000-4000-8000-000000000005";
const AGENT_CASOS = "ee0d0601-0000-4000-8000-000000000006";
const VERSION_CASOS = "ee0d0601-0000-4000-8000-000000000007";
const MARCA_DA_CORRECAO = "Este turno terminou SEM nenhuma mensagem ao cliente";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: string[] = [];

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const texto = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const enviar = (body: string) => ({
  content: [
    { type: "tool-call" as const, toolCallId: `c-${Math.random()}`, toolName: "send_message", input: JSON.stringify({ body }) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
/** Resposta cortada no teto de tokens — o seam devolve `finishReason: 'length'`. */
const cortado = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "length" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const FECHAMENTO = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" });

type Resposta = ReturnType<typeof texto> | ReturnType<typeof enviar> | ReturnType<typeof cortado>;

/** Roteiro por chamada; guarda o prompt de cada uma para conferir a correção. */
function modelo(roteiro: Resposta[]) {
  const prompts: string[] = [];
  const fake = async (options: { prompt: unknown }) => {
    prompts.push(JSON.stringify(options.prompt));
    return roteiro[prompts.length - 1] ?? texto(FECHAMENTO);
  };
  return { fake, prompts };
}

async function turno(
  fake: ReturnType<typeof modelo>["fake"],
  opts: { sessao?: string; conversa?: string } = {},
): Promise<void> {
  const sessao = opts.sessao ?? SESSION;
  const conversa = opts.conversa ?? CONV;
  if (conversa !== CONV) {
    // Conversa própria de cenário: mesma org/contato, sessão com casos ligados.
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
      [conversa, ORG, CONTACT, sessao],
    );
  }
  const msg = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
    [msg, ORG, conversa, sessao, CONTACT, "Juan Pérez, barrio Centro, portón verde, a las 12"],
  );
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: conversa,
      contact_id: CONTACT,
      channel_session_id: sessao,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "mudo", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
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
    registry: m.createFakeRegistry(fake as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (input: { body: string }) => {
          enviados.push(input.body);
          return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
  await handler(claimed!, pool, { workerId: "mudo" });
  await m.queue.completeJob(pool, claimed!.id, "mudo");
}

/** Casos humanos abertos na conversa — o que os cenários de falha medem. */
async function contarCasos(conversa: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_cases where organization_id = $1 and conversation_id = $2`,
    [ORG, conversa],
  );
  return rows[0]?.n ?? 0;
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
     values ($1,'turno-mudo','Turno Mudo','Turno Mudo') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'turno-mudo-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  // Sessão COM casos humanos ligados: `cases_enabled` vem false por padrão e a
  // régua `casesEnabled` gateia o openCase do desfecho terminal — sem este
  // agente publicado nenhum cenário de falha abre caso (mesmo fixture do
  // agent-config-cases.test.ts).
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'turno-mudo-casos-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1, $2, 'Agente com casos', 'system') on conflict (id) do nothing`,
    [AGENT_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, cases_enabled)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published', true)
     on conflict (id) do nothing`,
    [VERSION_CASOS, ORG, AGENT_CASOS, SESSION_CASOS],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [
    VERSION_CASOS,
    AGENT_CASOS,
  ]);
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
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Cliente de teste','+5511900000601')`,
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

describe("o turno de resposta que terminou sem mensagem ao cliente", () => {
  it("⭐ texto solto: a 2ª chamada leva a correção e a resposta SAI para o cliente", async () => {
    const { fake, prompts } = modelo([
      texto("¿Me pasás tu apellido completo?"), // o caso medido: pergunta fora de send_message
      enviar("¿Me pasás tu apellido completo? 😊"), // a correção
      texto("listo"),
    ]);
    await turno(fake);

    expect(enviados, "o cliente ficou sem resposta depois de mandar os dados").toEqual([
      "¿Me pasás tu apellido completo? 😊",
    ]);
    expect(prompts[1], "a 2ª chamada não levou o pedido de correção").toContain(MARCA_DA_CORRECAO);
    expect(prompts[0]).not.toContain(MARCA_DA_CORRECAO);
  });

  it("controle: o turno que já enviou não recebe correção nem chamada a mais", async () => {
    const { fake, prompts } = modelo([enviar("¡Listo! Tu pedido quedó confirmado ✅"), texto("ok")]);
    await turno(fake);

    expect(enviados).toEqual(["¡Listo! Tu pedido quedó confirmado ✅"]);
    // turno (2 passos: envio + encerramento) + fechamento = 3, sem correção.
    expect(prompts).toHaveLength(3);
    expect(prompts.some((p) => p.includes(MARCA_DA_CORRECAO))).toBe(false);
  });

  it("o silêncio que insiste recebe UMA correção — nunca um laço", async () => {
    const { fake, prompts } = modelo([texto("(nada a dizer)"), texto("(continuo sem nada a dizer)")]);
    await turno(fake);

    expect(enviados).toEqual([]);
    // turno + UMA correção + fechamento.
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(MARCA_DA_CORRECAO);
  });

  it("⭐ silêncio deliberado NÃO abre caso humano (#2938)", async () => {
    // Mantenedor: o modelo escolheu não responder (autorizado pela correção) —
    // isso é resposta, não defeito. Antes disto o caso abria à toa.
    const { fake } = modelo([texto("(nada a dizer)"), texto("(decidi não responder)")]);
    const conversa = crypto.randomUUID();
    await turno(fake, { sessao: SESSION_CASOS, conversa });

    expect(enviados).toEqual([]);
    expect(
      await contarCasos(conversa),
      "silêncio autorizado pela correção virou caso humano à toa",
    ).toBe(0);
  });

  it("⭐ saída truncada (length) sem envio abre caso para o time", async () => {
    // Mantenedor: a 1ª chamada cortou no teto de tokens, a correção tentou e
    // nada saiu → sinal de falha → UM caso humano.
    const { fake } = modelo([cortado("Claro, o seu pedido fica"), texto("(nada)")]);
    const conversa = crypto.randomUUID();
    await turno(fake, { sessao: SESSION_CASOS, conversa });

    expect(enviados).toEqual([]);
    expect(await contarCasos(conversa), "truncamento sem envio não virou caso").toBe(1);
  });

  it("saída truncada numa sessão SEM casos ligados não abre caso (régua casesEnabled)", async () => {
    // Controle do gate: a sessão base não tem agente com `cases_enabled=true`
    // (e a conversa é a 1:1 do contato nela, a CONV).
    const { fake } = modelo([cortado("Claro, o seu pedido fica"), texto("(nada)")]);
    await turno(fake);

    expect(enviados).toEqual([]);
    expect(await contarCasos(CONV), "caso abriu com casos desligados").toBe(0);
  });

  it("a correção que TAMBÉM trunca é sinal de falha — abre caso", async () => {
    // Decisão (b): a 1ª chamada parou em silêncio normal, mas a correção
    // limitada bateu no mesmo teto (length) → a recuperação falhou → caso.
    const { fake } = modelo([texto("(nada a dizer)"), cortado("(tentei corrigir mas a resposta cortou")]);
    const conversa = crypto.randomUUID();
    await turno(fake, { sessao: SESSION_CASOS, conversa });

    expect(enviados).toEqual([]);
    expect(await contarCasos(conversa), "correção truncada não virou caso").toBe(1);
  });
});
