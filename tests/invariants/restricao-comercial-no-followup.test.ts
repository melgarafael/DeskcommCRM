import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as FollowupTurn from "@/lib/agent-engine/agent/followup-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as Fronteira from "@/lib/atendimento/fronteira-server";

/**
 * FOLLOW-UP BARRADO PELA TRAVA DE VALORES NÃO FALA COM O CLIENTE (Spec 34).
 *
 * Medido numa VPS: um follow-up (nenhuma mensagem do cliente na conversa) escreveu
 * um texto com preço, a trava comercial o barrou, e o turno tratou o veto como se o
 * cliente tivesse perguntado de valores — mandou "Esse caso é melhor resolvido por
 * uma pessoa" a quem nunca escreveu e abriu um item crítico na Central.
 *
 * A régua é "tem mensagem do cliente esperando resposta?":
 *   • não → o texto só não sai (sem aviso, sem passar a conversa) e o veto fica na
 *     timeline com o texto e o trecho;
 *   • sim → o aviso e a passagem seguem como sempre (o cliente perguntou).
 *
 * Harness de `follow-up-usa-o-proprio-ponto.test.ts` (modelo fake roteirizado, canal
 * que captura). O CONTROLE — camada desligada — vem junto: é o que impede o verde por
 * ausência (o texto com preço SAI).
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

const ORG = "34000000-0000-4000-8000-000000000001";
const CONTACT = "34000000-0000-4000-8000-000000000002";
const SESSION = "34000000-0000-4000-8000-000000000003";
const CONV = "34000000-0000-4000-8000-000000000004";
const AGENT = "34000000-0000-4000-8000-000000000005";
const VERSION = "34000000-0000-4000-8000-000000000006";
const PIPE = "34000000-0000-4000-8000-000000000007";
const STAGE = "34000000-0000-4000-8000-000000000008";
const LEAD = "34000000-0000-4000-8000-000000000009";

/** Sexta, 14:30 em São Paulo — dentro da janela anti-ban de disparo (7h-22h). */
const INSTANTE = new Date("2026-09-04T17:30:00Z");

const TEXTO_COM_PRECO = "Fica sem custo nenhum";

type Modules = {
  createFollowupTurnHandler: typeof FollowupTurn.createFollowupTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  readCurrentServiceBoundary: typeof Fronteira.readCurrentServiceBoundary;
};
let m: Modules;

let enviados: Array<{ body: string }> = [];
/** O que o modelo viu como resultado de cada chamada de ferramenta, na ordem em que o SDK devolveu. */
let resultados: string[] = [];

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

interface Chamada {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Modelo fake roteirizado: devolve uma chamada de ferramenta por passo, na ordem, e
 * fecha com o checkpoint. Os resultados que o SDK devolveu ao modelo ficam em
 * `resultados` — sem isso, "o agente recebeu o erro" seria suposição.
 */
function modeloRoteirizado(roteiro: Chamada[], antesDaPrimeira?: () => Promise<void>) {
  let proximo = 0;
  const vistos = new Set<string>();
  return async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type !== "tool-result") continue;
        const id = String(parte.toolCallId ?? "");
        if (vistos.has(id)) continue;
        vistos.add(id);
        resultados.push(JSON.stringify(parte.output ?? parte));
      }
    }
    if (proximo === 0 && antesDaPrimeira) await antesDaPrimeira();
    const chamada = roteiro[proximo];
    if (chamada === undefined) {
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    proximo += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${proximo}`,
          toolName: chamada.tool,
          input: JSON.stringify(chamada.input),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

function deps(doGenerate: unknown) {
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
    registry: m.createFakeRegistry(doGenerate as never),
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

async function rodarFollowup(roteiro: Chamada[], antesDaPrimeira?: () => Promise<void>): Promise<Error | null> {
  const fronteira = await m.readCurrentServiceBoundary(pool, ORG, CONV);
  expect(fronteira, "a conversa do teste não tem fronteira de atendimento").not.toBeNull();
  // O PG efêmero é compartilhado: neutraliza jobs alheios para o claim FIFO pegar o deste.
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "followup_turn",
    leadId: CONTACT,
    payload: { service_boundary: fronteira, reason: "o cliente parou de responder" },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "followup-comercial", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  const handler = m.createFollowupTurnHandler(deps(modeloRoteirizado(roteiro, antesDaPrimeira)) as never);
  try {
    await handler(claimed!, pool, { workerId: "followup-comercial" });
    await m.queue.completeJob(pool, claimed!.id, "followup-comercial");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "followup-comercial", err);
    return err as Error;
  }
}

type Mensagem = { direction: "inbound" | "outbound"; body: string; minutosAtras: number; type?: string };

/** Substitui o histórico da conversa pelo desta cena. */
async function cena(lista: Mensagem[]): Promise<void> {
  await pool.query(`delete from messages where organization_id = $1 and conversation_id = $2`, [ORG, CONV]);
  for (const x of lista) {
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,$5,$6,$7,'delivered',$8,'external_device', now() - ($9 || ' minutes')::interval)`,
      [crypto.randomUUID(), ORG, CONV, SESSION, CONTACT, x.type ?? "text", x.direction, x.body, String(x.minutosAtras)],
    );
  }
}

const camada = (ligada: boolean) =>
  pool.query(
    `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, 'restricao_comercial', $2)
     on conflict (organization_id, layer) do update set enabled = excluded.enabled`,
    [ORG, ligada],
  );

const passagens = async () =>
  (
    await pool.query<{ n: number }>(
      `select count(*)::int as n from agent_inbox_items where organization_id = $1 and kind = 'handoff'`,
      [ORG],
    )
  ).rows[0]!.n;

const forceHuman = async () =>
  (await pool.query<{ f: boolean }>(`select force_human as f from contacts where id = $1 and organization_id = $2`, [CONTACT, ORG]))
    .rows[0]!.f;

const saidasGravadas = async () =>
  (
    await pool.query<{ n: number }>(
      `select count(*)::int as n from messages where organization_id = $1 and conversation_id = $2 and direction = 'outbound' and sent_at >= $3`,
      [ORG, CONV, new Date(Date.now() - 60_000).toISOString()],
    )
  ).rows[0]!.n;

const vetosDeValores = async () =>
  (
    await pool.query<{ n: number }>(
      `select count(*)::int as n from before_send_traces
        where organization_id = $1 and contact_id = $2 and vetoed_gate = 'commercial_restriction'`,
      [ORG, CONTACT],
    )
  ).rows[0]!.n;

const ENVIA_PRECO: Chamada = { tool: "send_message", input: { body: TEXTO_COM_PRECO } };
const PEDE_PASSAGEM: Chamada = {
  tool: "request_human_handoff",
  input: { por_que: "o cliente quer falar de valores" },
};
const ABRE_CASO: Chamada = {
  tool: "open_human_case",
  input: { title: "Valores", summary: "cliente quer valores", blocker: "só a equipe fala de valores", kind: "financeiro" },
};

beforeAll(async () => {
  m = {
    createFollowupTurnHandler: (await import("@/lib/agent-engine/agent/followup-turn")).createFollowupTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    readCurrentServiceBoundary: (await import("@/lib/atendimento/fronteira-server")).readCurrentServiceBoundary,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'restricao-comercial-followup','Restricao Comercial Followup','Restricao Comercial Followup')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead do Follow-up','+5511900003434') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'restricao-comercial-followup','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1, $2, 'Vendedor do teste', 'você é um vendedor', 'mcp_agent') on conflict (id) do nothing`,
    [AGENT, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um vendedor', 'anthropic', 'claude-do-teste', $4, 'published', now())
     on conflict (id) do nothing`,
    [VERSION, ORG, AGENT, SESSION],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [VERSION, AGENT]);
  // Um negócio aberto: é onde a linha "Não enviei" se pendura.
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, is_default)
     values ($1,$2,'Pipeline 34','pipeline-34',false) on conflict do nothing`,
    [PIPE, ORG],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1,$2,$3,'Etapa','etapa',1000) on conflict (id) do nothing`,
    [STAGE, ORG, PIPE],
  );
  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, status)
     values ($1,$2,$3,$4,'Negócio do follow-up',$5,'open') on conflict (id) do nothing`,
    [LEAD, ORG, PIPE, STAGE, CONTACT],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  enviados = [];
  resultados = [];
  await camada(true);
  await pool.query(`delete from agent_inbox_items where organization_id = $1`, [ORG]);
  await pool.query(`delete from crm_lead_activities where organization_id = $1 and lead_id = $2`, [ORG, LEAD]);
  await pool.query(`delete from before_send_traces where organization_id = $1`, [ORG]);
  await pool.query(`update contacts set force_human = false where id = $1 and organization_id = $2`, [CONTACT, ORG]);
  await pool.query(`update conversations set status = 'ai_handling', bot_silenced_until = null where id = $1`, [CONV]);
});

describe("follow-up com texto de preço e cliente SEM mensagem esperando", () => {
  it("CONTROLE — camada desligada: o texto com preço sai", async () => {
    await camada(false);
    await cena([]);
    expect(await rodarFollowup([ENVIA_PRECO])).toBeNull();
    expect(enviados.map((e) => e.body)).toContain(TEXTO_COM_PRECO);
    expect(await vetosDeValores()).toBe(0);
  });

  it("(a) conversa sem nenhuma mensagem do cliente: não sai, não avisa, não passa, e o veto mostra o texto e o trecho", async () => {
    await cena([]);
    expect(await rodarFollowup([ENVIA_PRECO])).toBeNull();
    expect(enviados).toEqual([]);
    expect(await saidasGravadas()).toBe(0);
    expect(await passagens()).toBe(0);
    expect(await forceHuman()).toBe(false);
    expect(resultados[0]).toContain("não passe a conversa para a equipe");

    const { rows } = await pool.query<{ reason: string; texto: string; trecho: string }>(
      `select reason, payload->>'texto_barrado' as texto, payload->>'trecho' as trecho
         from crm_lead_activities where lead_id = $1 and type = 'send_vetoed'`,
      [LEAD],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      reason: 'Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe (o texto tinha "custo")',
      texto: TEXTO_COM_PRECO,
      trecho: "custo",
    });
    // O rastro da cadeia segue SEM corpo e SEM trecho (a PII mora só na linha da timeline).
    const { rows: rastro } = await pool.query<{ t: string }>(
      `select trace::text as t from before_send_traces where organization_id = $1 and contact_id = $2`,
      [ORG, CONTACT],
    );
    expect(rastro.length).toBeGreaterThan(0);
    for (const r of rastro) {
      expect(r.t).not.toContain("custo");
      expect(r.t).not.toContain(TEXTO_COM_PRECO);
    }
  });

  it("(b) a mensagem do cliente já foi respondida: igual a (a)", async () => {
    await cena([
      { direction: "inbound", body: "oi", minutosAtras: 120 },
      { direction: "outbound", body: "olá! como posso ajudar?", minutosAtras: 110 },
    ]);
    expect(await rodarFollowup([ENVIA_PRECO])).toBeNull();
    expect(enviados).toEqual([]);
    expect(await passagens()).toBe(0);
    expect(await forceHuman()).toBe(false);
  });

  it("(d) depois do veto, pedir passagem ou abrir caso é recusado: nada é aberto e ninguém é avisado", async () => {
    await cena([]);
    expect(await rodarFollowup([ENVIA_PRECO, PEDE_PASSAGEM, ABRE_CASO])).toBeNull();
    expect(enviados).toEqual([]);
    expect(await passagens()).toBe(0);
    expect(await forceHuman()).toBe(false);
    expect(resultados.some((r) => r.includes("handoff_bloqueado_apos_veto_comercial"))).toBe(true);
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from agent_cases where organization_id = $1`,
      [ORG],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("(e) mensagem do cliente que chega DEPOIS da abertura do turno não faz o follow-up avisar", async () => {
    await cena([]);
    const chegaNoMeio = async () => {
      await pool.query(
        `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
           type, direction, status, body, sent_via, sent_at)
         values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, tudo bem?','external_device', now())`,
        [crypto.randomUUID(), ORG, CONV, SESSION, CONTACT],
      );
    };
    await rodarFollowup([ENVIA_PRECO], chegaNoMeio);
    expect(await passagens()).toBe(0);
    expect(await forceHuman()).toBe(false);
  });

  it("(g) insistir três vezes: a segunda recebe o aviso final e a terceira nem chama a cadeia", async () => {
    await cena([]);
    expect(await rodarFollowup([ENVIA_PRECO, ENVIA_PRECO, ENVIA_PRECO])).toBeNull();
    expect(enviados).toEqual([]);
    expect(resultados[1]).toContain("Termine o turno sem enviar mensagem");
    expect(resultados[2]).toContain("Termine o turno sem enviar mensagem");
    expect(await vetosDeValores()).toBe(2);
    expect(await passagens()).toBe(0);
  });
});

describe("follow-up com texto de preço e cliente COM mensagem esperando", () => {
  it("(c) mensagem do cliente sem resposta: a passagem segue como sempre", async () => {
    await cena([{ direction: "inbound", body: "quanto custa?", minutosAtras: 30 }]);
    await rodarFollowup([ENVIA_PRECO]);
    expect(enviados.map((e) => e.body)).not.toContain(TEXTO_COM_PRECO);
    expect(await passagens()).toBe(1);
    expect(await forceHuman()).toBe(true);
  });

  it("(f) o cliente mandou só uma foto (corpo vazio) e ninguém respondeu: conta como esperando, igual a (c)", async () => {
    await cena([{ direction: "inbound", body: "", type: "image", minutosAtras: 30 }]);
    await rodarFollowup([ENVIA_PRECO]);
    expect(enviados.map((e) => e.body)).not.toContain(TEXTO_COM_PRECO);
    expect(await passagens()).toBe(1);
    expect(await forceHuman()).toBe(true);
  });
});
