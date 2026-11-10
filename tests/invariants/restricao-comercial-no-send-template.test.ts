import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O TEMPLATE QUE O MODELO ESCOLHE, BARRADO PELA RESTRIÇÃO COMERCIAL, VAI À EQUIPE (#3270).
 *
 * `gate-comercial.test.ts` prova que a cadeia veta o corpo com `isTemplate`. O que
 * só o turno inteiro prova é o que vem DEPOIS do veto: o `send_template` chama
 * `passarComercialParaEquipe` (aviso + `performHumanHandoff` com o título de
 * "Valores e negociação"). Sem esse ramo o veto vira só um erro devolvido ao
 * modelo — nada sai, mas ninguém da equipe fica sabendo, e o cliente que pediu
 * preço fica sem resposta. Um guard de forma não distinguia os dois mundos: os
 * dois compilam e não enviam.
 *
 * Harness do irmão `agent-send-template-turn.test.ts` (modelo fake que chama a
 * tool UMA vez, canal que captura). O CONTROLE roda primeiro, com a camada
 * DESLIGADA: o mesmo template SAI — é o que impede o verde por ausência.
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

const ORG = "28770000-0000-4000-8000-000000000001";
const CONTACT = "28770000-0000-4000-8000-000000000002";
/** Sessão Cloud API — o canal que EXIGE template fora da janela. */
const SESSION_META = "28770000-0000-4000-8000-000000000003";
const CONV = "28770000-0000-4000-8000-000000000004";
const MSG = "28770000-0000-4000-8000-000000000005";

interface EnvioCapturado {
  body: string;
  template?: { name: string; language: string; values: Record<string, string> };
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

/** O que o modelo devolveu ao ver o resultado da tool — é onde o erro instrutivo aparece. */
let ultimoResultadoDeTool: unknown = null;
let enviados: EnvioCapturado[] = [];

/**
 * O fechamento do turno pede um JSON de checkpoint (`checkpointContentSchema`), e o
 * `parseCheckpointText` rejeita qualquer coisa sem `{...}` — o run então re-tenta pela
 * fila. Um modelo fake que só devolve prosa faz o turno **enviar e não fechar**, e foi
 * exatamente assim que a primeira versão deste arquivo passou no envio e falhou no fim.
 */
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
 * Modelo fake que chama `send_template` UMA vez e depois encerra.
 *
 * A segunda chamada captura o `toolResult` que o SDK devolveu — sem isso, "o modelo
 * recebeu o erro" seria suposição: o turno terminaria igual tendo ou não recebido.
 */
function modeloQueChamaTemplate(input: Record<string, unknown>) {
  let chamou = false;
  return async (opts: { prompt?: unknown }) => {
    if (chamou) {
      const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
      for (const msg of msgs) {
        if (!Array.isArray(msg.content)) continue;
        for (const parte of msg.content as Array<Record<string, unknown>>) {
          if (parte.type === "tool-result") ultimoResultadoDeTool = parte.output ?? parte;
        }
      }
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    chamou = true;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "c1",
          toolName: "send_template",
          input: JSON.stringify(input),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
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
      maxSteps: 4,
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
    // Captura em vez de enviar: o que importa é o que o runtime ENTREGOU ao canal.
    channel: () =>
      ({
        channel: "captura",
        send: async (i: EnvioCapturado) => {
          enviados.push(i);
          return { kind: "sent" as const, idempotencyKey: "k", messageId: "m1" };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: false, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Instante fixo DENTRO da janela horária do anti-ban: um horário fora dela
    // reprovaria o turno por um motivo que não é o deste teste.
    clock: () => new Date("2026-07-30T15:00:00Z"),
    sleep: async () => {},
  });
}

async function rodaTurno(
  handler: ReturnType<typeof montaHandler>,
  alvo: { conv: string; sessao: string; msg: string; evento: string },
): Promise<Error | null> {
  // O PG efêmero é compartilhado: neutraliza jobs alheios para o claim FIFO pegar o deste.
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: alvo.conv,
      contact_id: CONTACT,
      channel_session_id: alvo.sessao,
      inbound_message_id: alvo.msg,
      crm_event_id: alvo.evento,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "tpl", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  // O CONTRATO DO WORKER (`runJob` de main.ts): sucesso → completeJob, falha → failJob.
  // Sem isso o job fica 'running' e, com `maxConcurrency: 1`, o claim do teste SEGUINTE
  // não pega nada — foi assim que os quatro casos posteriores a este falharam com
  // "expected undefined", por um motivo que não era o deles.
  try {
    await handler(claimed!, pool, { workerId: "tpl" });
    await m.queue.completeJob(pool, claimed!.id, "tpl");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "tpl", err);
    return err as Error;
  }
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'restricao-comercial-template','Restricao Comercial Template','Restricao Comercial Template')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Template','+5511900002877') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id,
                                   meta_waba_id, status, webhook_secret_encrypted)
     values ($1,$2,'meta_cloud','111','222','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION_META, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'open',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION_META],
  );
  // 30 HORAS: a janela de 24h está FECHADA. É o que dá sentido ao template — e o que
  // faria o gate `messaging_window` vetar um envio de texto livre.
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi','external_device',
             now() - interval '30 hours')
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION_META, CONTACT],
  );
  // O corpo RENDERIZADO tem preço: é ele que a régua de saída julga.
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, name, language, status, category,
                                 components, parameter_format, contract_hash)
     values ($1,'222','oferta','pt_BR','APPROVED','MARKETING',
       '[{"type":"BODY","text":"Oi {{1}}, o investimento é de R$ 199,90."}]'::jsonb,'POSITIONAL','h-oferta')
     on conflict (organization_id, waba_id, name, language) do update set status = 'APPROVED'`,
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

beforeEach(() => {
  enviados = [];
  ultimoResultadoDeTool = null;
});

const ALVO_META = { conv: CONV, sessao: SESSION_META, msg: MSG, evento: "28770000-0000-4000-8000-000000000006" };
const camada = (ligada: boolean) =>
  pool.query(
    `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, 'restricao_comercial', $2)
     on conflict (organization_id, layer) do update set enabled = excluded.enabled`,
    [ORG, ligada],
  );
const passagensComerciais = async () =>
  (await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_inbox_items
      where organization_id = $1 and kind = 'handoff' and title like 'Valores e negociação%'`,
    [ORG],
  )).rows[0]!.n;
const chamaOferta = () =>
  montaHandler(modeloQueChamaTemplate({ template_name: "oferta", language: "pt_BR", values: { "1": "Ana" } }));

describe("send_template com preço numa org que deixou valores com a equipe", () => {
  it("CONTROLE — camada desligada: o mesmo template sai", async () => {
    await camada(false);
    expect(await rodaTurno(chamaOferta(), ALVO_META)).toBeNull();
    expect(enviados.map((e) => e.template?.name)).toEqual(["oferta"]);
    expect(await passagensComerciais()).toBe(0);
  });

  it("camada ligada: o template NÃO sai e a conversa vai à equipe como valores e negociação", async () => {
    await camada(true);
    expect(await rodaTurno(chamaOferta(), ALVO_META)).toBeNull();
    expect(enviados.filter((e) => e.template !== undefined || e.body.includes("199"))).toEqual([]);
    expect(await passagensComerciais()).toBe(1);
    expect(JSON.stringify(ultimoResultadoDeTool)).toMatch(/commercial_requires_human/);
  });
});
