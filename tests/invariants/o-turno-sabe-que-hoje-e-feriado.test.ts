import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O PROMPT DO TURNO DIZ QUE HOJE (OU AMANHÃ) É FERIADO NACIONAL (#3877).
 *
 * ─── O defeito que este arquivo impede ──────────────────────────────────────
 *
 * Em 02/11/2026 (Finados, feriado nacional) dois agentes desta instalação
 * disseram a clientes "atendemos hoje até as 18h", e um deles convidou a pessoa
 * a ir até a loja. A empresa estava fechada. O prompt informa o horário
 * semanal e o bloco `## Agora` informa o dia da semana — o agente aplicou o
 * expediente de segunda-feira porque era segunda-feira. Faltava o FATO de que
 * aquele dia é feriado, e nenhum lugar do contexto do turno o trazia.
 *
 * O teste unitário irmão (`tests/unit/o-turno-sabe-que-hoje-e-feriado.test.ts`)
 * prova a conta: data local, véspera, dia comum, dois fusos, país estrangeiro.
 * Ele NÃO prova que o bloco chega ao modelo — apagar a linha que o põe em
 * `openingSuffixes` o deixa inteiramente verde. Quem guarda o call site é este
 * arquivo: ele roda o handler REAL e lê o prompt que de fato saiu.
 *
 * ─── Por que 21h de 02/11, e não o meio da tarde ────────────────────────────
 *
 * `2026-11-03T00:00:00Z` é 21h de SEGUNDA-FEIRA, 02/11, em São Paulo — e já é
 * 03/11 em UTC. É o instante que separa "data local" de "data em UTC": uma
 * implementação que formatasse a data em UTC diria que hoje NÃO é feriado (e
 * que amanhã, 04/11, também não), e este arquivo reprova. O horário também
 * está dentro da janela anti-ban (7h–22h) no fuso do pacing, senão o turno
 * seria adiado antes de montar prompt nenhum e o arquivo mediria outra coisa.
 *
 * ─── A segunda organização é de Portugal ────────────────────────────────────
 *
 * Mesmo instante, `organizations.country = 'PT'`: o prompt NÃO pode carregar
 * feriado brasileiro. Uma clínica em Lisboa com o Finados no prompt prometeria
 * fechamento num dia em que abre — o mesmo defeito, ao contrário. É o caso de
 * controle do país, e ele roda o turno de verdade, não só a função pura.
 *
 * Harness copiado de `o-turno-diz-ao-modelo-que-dia-e-hoje.test.ts` (handler
 * real, modelo fake, canal que captura, `sleep` no-op), com ids próprios.
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

/** Organização brasileira (coluna `country` vazia = Brasil). */
const ORG_BR = "eeeeeeee-0000-4000-8000-0000000000c1";
const CONTACT_BR = "eeeeeeee-0000-4000-8000-0000000000c2";
const SESSION_BR = "eeeeeeee-0000-4000-8000-0000000000c3";
const CONV_BR = "eeeeeeee-0000-4000-8000-0000000000c4";
const MSG_BR = "eeeeeeee-0000-4000-8000-0000000000c5";

/** Organização portuguesa — mesma hora, outro país. */
const ORG_PT = "eeeeeeee-0000-4000-8000-0000000000d1";
const CONTACT_PT = "eeeeeeee-0000-4000-8000-0000000000d2";
const SESSION_PT = "eeeeeeee-0000-4000-8000-0000000000d3";
const CONV_PT = "eeeeeeee-0000-4000-8000-0000000000d4";
const MSG_PT = "eeeeeeee-0000-4000-8000-0000000000d5";

/** 21h de 02/11/2026 em São Paulo — já 03/11 em UTC. */
const INSTANTE = new Date("2026-11-03T00:00:00Z");

/**
 * 10h de 02/11 (Finados) em Lisboa — e 07h em São Paulo.
 *
 * Outro instante para a organização portuguesa por um motivo do INSTRUMENTO, não
 * do defeito: a janela anti-ban é avaliada no fuso da organização, e 00h em
 * Lisboa (o instante acima) adia o turno antes de montar prompt nenhum — o
 * arquivo mediria o reagendamento, não o feriado.
 */
const INSTANTE_PT = new Date("2026-11-02T10:00:00Z");

/** O que o turno brasileiro TEM de dizer. */
const ESPERADO = "Hoje (02/11/2026) é feriado nacional no Brasil";

interface EnvioCapturado {
  body: string;
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];
/** Todo prompt que chegou ao modelo neste turno, já serializado. */
let promptsVistos: string[] = [];

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

/** Modelo fake que GRAVA o prompt recebido, manda uma mensagem e encerra. */
function modeloQueGravaOPrompt() {
  let mandou = false;
  return async (options: { prompt: unknown }) => {
    promptsVistos.push(JSON.stringify(options.prompt));
    if (!mandou) {
      mandou = true;
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "send_message",
            input: JSON.stringify({ body: "oi, consigo te encaixar sim" }),
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
    llmCfg: { anthropicApiKey: "chave-de-teste" } as never,
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
    clock: () => instante,
    sleep: async () => {},
  });
}

interface Cenario {
  org: string;
  contato: string;
  conversa: string;
  mensagem: string;
  evento: string;
}

async function rodaTurno(
  handler: ReturnType<typeof montaHandler>,
  c: Cenario,
): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, c.org, {
    kind: "inbound_turn",
    leadId: c.contato,
    payload: {
      conversation_id: c.conversa,
      contact_id: c.contato,
      channel_session_id: c.org === ORG_BR ? SESSION_BR : SESSION_PT,
      inbound_message_id: c.mensagem,
      crm_event_id: c.evento,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "feriado", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "feriado" });
    await m.queue.completeJob(pool, claimed!.id, "feriado");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "feriado", err);
    return err as Error;
  }
}

const BR: Cenario = {
  org: ORG_BR,
  contato: CONTACT_BR,
  conversa: CONV_BR,
  mensagem: MSG_BR,
  evento: "eeeeeeee-0000-4000-8000-0000000000c6",
};
const PT: Cenario = {
  org: ORG_PT,
  contato: CONTACT_PT,
  conversa: CONV_PT,
  mensagem: MSG_PT,
  evento: "eeeeeeee-0000-4000-8000-0000000000d6",
};

async function semear(
  c: Cenario,
  org: { slug: string; timezone: string; country: string | null },
  sessionId: string,
) {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone, country)
     values ($1,$2,$3,$3,$4,$5)
     on conflict (id) do update set timezone = excluded.timezone, country = excluded.country`,
    [c.org, org.slug, `Feriado ${org.slug}`, org.timezone, org.country],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead do Feriado','+5511999990888') on conflict (id) do nothing`,
    [c.contato, c.org],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,$3,'WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [sessionId, c.org, `${org.slug}-session`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [c.conversa, c.org, c.contato, sessionId],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, vocês abrem hoje?','external_device', now())
     on conflict (id) do nothing`,
    [c.mensagem, c.org, c.conversa, sessionId, c.contato],
  );
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  // Brasil: a coluna `country` fica NULA — é o valor de quem nunca trocou o
  // campo, e é o que significa Brasil (`lib/legal/perfil-do-pais.ts`).
  await semear(
    BR,
    { slug: "feriado-br", timezone: "America/Sao_Paulo", country: null },
    SESSION_BR,
  );
  await semear(PT, { slug: "feriado-pt", timezone: "Europe/Lisbon", country: "PT" }, SESSION_PT);

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
  promptsVistos = [];
});

describe("o prompt do turno carrega o feriado nacional", () => {
  it("organização brasileira: a abertura diz que HOJE é feriado, na data LOCAL", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueGravaOPrompt(), INSTANTE), BR);

    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
    // O turno chama o modelo mais de uma vez (resposta + checkpoint); o fato
    // tem de estar na PRIMEIRA, que é a que decide o que prometer ao lead.
    expect(promptsVistos.length).toBeGreaterThan(0);
    expect(promptsVistos[0]).toContain("## Feriado nacional");
    expect(promptsVistos[0]).toContain(ESPERADO);
  });

  it("a data é a de SÃO PAULO, não a de UTC — 21h de 02/11, não 03/11", async () => {
    // Com `new Date().toISOString()` (03/11) o bloco diria que hoje e amanhã
    // não são feriados: é a linha INTEIRA que reprova, não a hora solta.
    await rodaTurno(montaHandler(modeloQueGravaOPrompt(), INSTANTE), BR);

    expect(promptsVistos[0]).not.toContain("Hoje (03/11/2026)");
    expect(promptsVistos[0]).not.toContain("NÃO são feriados nacionais");
  });

  it("organização de PORTUGAL não recebe feriado brasileiro", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueGravaOPrompt(), INSTANTE_PT), PT);

    expect(erro).toBeNull();
    expect(promptsVistos[0]).not.toContain("Feriado nacional");
    expect(promptsVistos[0]).not.toContain("feriados nacionais no Brasil");
    // O relógio continua lá — o que muda é só o fato do feriado.
    expect(promptsVistos[0]).toContain("## Agora");
  });
});
