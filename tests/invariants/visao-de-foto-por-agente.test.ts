import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as AgentConfig from "@/lib/agent-engine/agent/agent-config";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as LeadContext from "@/lib/agent-engine/edge/crm/get-lead-context";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * "VER AS FOTOS QUE O CLIENTE ENVIA", POR AGENTE (migration 9108), sobre o
 * baseline instalado e pelo turno real (handler de `inbound_turn`).
 *
 *  1. A coluna nasce `true` e NOT NULL: toda versão que existe segue vendo foto.
 *     O loader do motor a lê — sem a coluna, todo turno falharia com 42703.
 *  2. A versão PUBLICADA não muda a opção: sem a linha no trigger
 *     `fn_ai_agent_version_content_immutable`, a service key ligaria a visão de
 *     um agente no ar sem versão nova e sem trilha.
 *  3. No turno, o agente com a opção DESLIGADA não recebe a descrição da foto
 *     — que existe, porque outro agente da empresa a pediu — e sim o aviso de
 *     imagem não vista, no histórico e na linha que o turno responde. Nem a
 *     IMAGEM NATIVA vai ao modelo (`multimodal_input` vem ligado, e é o caminho
 *     principal pelo qual o agente vê a foto). O controle é o mesmo turno com a
 *     opção ligada, que lê a descrição e recebe a imagem.
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

const ORG = "c0909079-0000-4000-8000-000000000001";
const CONTACT = "c0909079-0000-4000-8000-000000000002";
const DESCRICAO = "Tênis vermelho de corrida, tamanho 42, com a sola gasta no calcanhar";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
  loadAgentVersionConfig: typeof AgentConfig.loadAgentVersionConfig;
  MARCADOR_IMAGEM_NAO_VISTA: typeof LeadContext.MARCADOR_IMAGEM_NAO_VISTA;
};
let m: Modules;

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
const FECHAMENTO = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" });

/** Guarda o prompt de cada chamada: é nele que se lê o que o agente viu. */
function modelo(fala: string) {
  const prompts: string[] = [];
  const roteiro = [enviar(fala), texto("ok")];
  const fake = async (options: { prompt: unknown }) => {
    prompts.push(JSON.stringify(options.prompt));
    return roteiro[prompts.length - 1] ?? texto(FECHAMENTO);
  };
  return { fake, prompts };
}

/** Sessão + conversa + agente publicado nela, com a opção como pedida. */
async function agenteNaSessao(visao: boolean | null): Promise<{ session: string; conv: string; version: string; agent: string }> {
  const session = randomUUID();
  const conv = randomUUID();
  const agent = randomUUID();
  const version = randomUUID();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,$3,'WORKING','\\x00'::bytea)`,
    [session, ORG, `visao-${session.slice(0, 8)}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [conv, ORG, CONTACT, session],
  );
  await pool.query(`insert into ai_agents (id, organization_id, name, system_prompt) values ($1,$2,$3,'system')`, [
    agent,
    ORG,
    `Agente ${agent.slice(0, 8)}`,
  ]);
  // `null` = a coluna nem é citada: o default do banco decide.
  if (visao === null) {
    await pool.query(
      `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model,
                                      channel_session_id, status)
       values ($1,$2,$3,1,'system','anthropic','claude-sonnet-4-6',$4,'published')`,
      [version, ORG, agent, session],
    );
  } else {
    await pool.query(
      `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model,
                                      channel_session_id, status, image_vision_enabled)
       values ($1,$2,$3,1,'system','anthropic','claude-sonnet-4-6',$4,'published',$5)`,
      [version, ORG, agent, session, visao],
    );
  }
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  return { session, conv, version, agent };
}

/** A foto que o cliente mandou, JÁ descrita (outro leitor da empresa a pediu). */
async function fotoDescrita(session: string, conv: string, legenda: string | null): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction,
                           status, body, sent_via, sent_at, created_at, media_url, media_mime, media_storage_path,
                           media_derived_text, media_derived_status)
     values ($1,$2,$3,$4,$5,'image','inbound','delivered',$6,'external_device',now(),now(),
             'http://waha/files/x.jpg','image/jpeg',$7,$8,'ready')`,
    [id, ORG, conv, session, CONTACT, legenda, `${ORG}/${conv}/${id}.jpg`, DESCRICAO],
  );
  return id;
}

async function turno(session: string, conv: string, inbound: string, fake: ReturnType<typeof modelo>["fake"]) {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: conv,
      contact_id: CONTACT,
      channel_session_id: session,
      inbound_message_id: inbound,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "visao", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  let enviados = 0;
  // O storage da mídia: a imagem nativa do turno sai daqui (`buildNativeMediaParts`).
  const supabase = {
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])]), error: null }),
      }),
    },
  };
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: supabase as never },
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
  await handler(claimed!, pool, { workerId: "visao" });
  await m.queue.completeJob(pool, claimed!.id, "visao");
}

/** O texto JSON do prompt traz o marcador com as aspas escapadas: compara pelo JSON. */
const noPrompt = (s: string) => JSON.stringify(s).slice(1, -1);
/** A parte nativa de imagem no pedido ao modelo (`file` com o tipo da foto). */
const IMAGEM_NATIVA = '"mediaType":"image/jpeg"';

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    loadAgentVersionConfig: (await import("@/lib/agent-engine/agent/agent-config")).loadAgentVersionConfig,
    MARCADOR_IMAGEM_NAO_VISTA: (await import("@/lib/agent-engine/edge/crm/get-lead-context")).MARCADOR_IMAGEM_NAO_VISTA,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'visao-de-foto-por-agente','Visão por agente','Visão por agente') on conflict (id) do nothing`,
    [ORG],
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
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Cliente','+5511900009079')`,
    [CONTACT, ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});

describe("a coluna (9108)", () => {
  it("nasce true e NOT NULL, e o loader do motor a lê", async () => {
    const { rows } = await pool.query<{ column_default: string | null; is_nullable: string }>(
      `select column_default, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'ai_agent_versions' and column_name = 'image_vision_enabled'`,
    );
    expect(rows).toEqual([{ column_default: "true", is_nullable: "NO" }]);

    const padrao = await agenteNaSessao(null);
    expect((await m.loadAgentVersionConfig(pool, ORG, padrao.agent, padrao.version))?.imageVisionEnabled).toBe(true);
    const desligado = await agenteNaSessao(false);
    expect((await m.loadAgentVersionConfig(pool, ORG, desligado.agent, desligado.version))?.imageVisionEnabled).toBe(
      false,
    );
  });

  it("versão PUBLICADA recusa mudar a opção, e o valor fica igual", async () => {
    const a = await agenteNaSessao(false);
    await expect(
      pool.query("update ai_agent_versions set image_vision_enabled = true where id = $1", [a.version]),
    ).rejects.toThrow(/imutável/);
    const { rows } = await pool.query<{ image_vision_enabled: boolean }>(
      "select image_vision_enabled from ai_agent_versions where id = $1",
      [a.version],
    );
    expect(rows[0]!.image_vision_enabled).toBe(false);
  });
});

describe("o turno do agente", () => {
  it("opção DESLIGADA: a descrição não entra; entra o aviso de imagem não vista, com a legenda", async () => {
    const a = await agenteNaSessao(false);
    const foto = await fotoDescrita(a.session, a.conv, "quero esse");
    const { fake, prompts } = modelo("Recebi sua foto! Me conta o que é?");
    await turno(a.session, a.conv, foto, fake);

    expect(prompts.length, "o turno não chamou o modelo").toBeGreaterThan(0);
    const primeiro = prompts[0]!;
    expect(primeiro, "o agente que desligou a visão recebeu a descrição da foto").not.toContain("Tênis vermelho");
    expect(primeiro).toContain(noPrompt(m.MARCADOR_IMAGEM_NAO_VISTA));
    expect(primeiro, "a legenda que o cliente digitou some junto").toContain("quero esse");
    expect(primeiro, "a imagem nativa foi ao modelo do agente que desligou a visão").not.toContain(IMAGEM_NATIVA);
  });

  it("controle: o mesmo turno com a opção ligada lê a descrição", async () => {
    const a = await agenteNaSessao(true);
    const foto = await fotoDescrita(a.session, a.conv, null);
    const { fake, prompts } = modelo("Que tênis bonito! Tem no 42 sim.");
    await turno(a.session, a.conv, foto, fake);

    expect(prompts[0]).toContain("Tênis vermelho");
    expect(prompts[0]).not.toContain(noPrompt(m.MARCADOR_IMAGEM_NAO_VISTA));
    expect(prompts[0], "controle: com a visão ligada, a imagem nativa vai").toContain(IMAGEM_NATIVA);
  });
});
