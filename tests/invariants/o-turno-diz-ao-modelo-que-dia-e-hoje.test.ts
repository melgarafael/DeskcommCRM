import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O PROMPT DO TURNO CARREGA A DATA DE HOJE, NO FUSO DA ORGANIZAÇÃO.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * O ritual de abertura entregava checkpoint, funil, notas e histórico — e
 * nenhum relógio. `crm_book_appointment` exige `starts_at` como instante
 * absoluto; sem saber que dia é hoje, o modelo não tem de onde tirá-lo, e
 * "quinta às 14h" não vira agendamento nenhum. O sintoma no cliente não é erro:
 * é o agente respondendo "vou confirmar com a equipe" para sempre.
 *
 * O teste unitário irmão (`tests/unit/o-turno-sabe-que-horas-sao.test.ts`)
 * prova que `renderAgora` formata certo. Ele NÃO prova que o bloco chega ao
 * modelo: apagar a linha que o põe em `openingSuffixes` o deixa inteiramente
 * verde. Quem guarda o call site é este arquivo — ele roda o handler REAL e lê
 * o prompt que de fato saiu.
 *
 * ─── Por que Manaus, e não São Paulo ────────────────────────────────────────
 *
 * Este é o caso de controle, e ele separa duas colunas que guardam a MESMA
 * string em toda instalação brasileira:
 *
 *   organizations.timezone   → o fuso que a PESSOA escolheu no onboarding.
 *   channel_knobs.timezone   → knob ANTI-BAN por canal. Nada no repo o semeia
 *                              a partir da org: linha ausente cai em
 *                              `PACING_DEFAULTS.timezone`, o literal de
 *                              São Paulo.
 *
 * A segunda estava à mão dentro do turno, o que faz dela a escolha tentadora —
 * e errada por uma hora inteira em Manaus, calada, porque numa org paulista as
 * duas coincidem e nenhum teste vê diferença. Aqui a org é de Manaus e o canal
 * não tem knob: se alguém trocar a fonte pelo fuso do pacing, o bloco dirá
 * 14:30 e este arquivo reprova.
 *
 * ─── O vermelho que não era defeito (#506) ──────────────────────────────────
 *
 * A asserção procurava a hora SOLTA (`"14:30"`) no prompt inteiro — e o prompt
 * carrega carimbos de tempo cunhados durante a execução, como o `sent_at` do
 * histórico que esta fixture semeia com `now()`. Qualquer um deles contém
 * `14:30` quando o relógio do runner está nesse minuto, e o gate reprovava sem
 * defeito nenhum de produção: um vermelho que depende da hora de parede treina
 * quem observa a ignorar o gate. Agora a asserção mira a LINHA INTEIRA que o
 * defeito produziria — e nenhum carimbo de tempo reproduz uma linha inteira.
 *
 * ─── O instante ─────────────────────────────────────────────────────────────
 *
 * `2026-09-04T17:30:00Z` = sexta, 14:30 em São Paulo e 13:30 em Manaus. Escolhi
 * o meio da tarde de propósito: precisa estar DENTRO da janela anti-ban (7h-22h,
 * avaliada no fuso do pacing) nos dois fusos, senão o turno é adiado antes de
 * montar prompt nenhum e o arquivo mediria outra coisa.
 *
 * Harness copiado de `janela-usa-o-relogio-injetado.test.ts` (handler real,
 * modelo fake, canal que captura, `sleep` no-op), com ids próprios: o banco é
 * recriado por arquivo, mas ids distintos mantêm o log legível quando os dois
 * rodam na mesma corrida.
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

const ORG = "dddddddd-0000-4000-8000-0000000000b1";
const CONTACT = "dddddddd-0000-4000-8000-0000000000b2";
const SESSION = "dddddddd-0000-4000-8000-0000000000b3";
const CONV = "dddddddd-0000-4000-8000-0000000000b4";
const MSG = "dddddddd-0000-4000-8000-0000000000b5";
const CRM_EVENT = "dddddddd-0000-4000-8000-0000000000b6";

/** Sexta, 14:30 em São Paulo — e 13:30 em Manaus, que é o fuso desta org. */
const INSTANTE = new Date("2026-09-04T17:30:00Z");

/** O que o bloco tem de dizer. Se sair a hora de São Paulo, a fonte está errada. */
const ESPERADO_MANAUS = "sexta-feira, 04/09/2026, 13:30 (America/Manaus)";
/**
 * O que ele NÃO pode dizer — a linha INTEIRA que sairia com o fuso do pacing.
 * Não é hora solta de propósito: `"14:30"` cru colide com os carimbos de tempo
 * que o prompt carrega (o `sent_at` do histórico é cunhado durante a execução),
 * e aí o arquivo reprova por hora de parede do runner — ver o cabeçalho (#506).
 */
const BLOCO_DO_PACING = "sexta-feira, 04/09/2026, 14:30 (America/Sao_Paulo)";

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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "relogio", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "relogio" });
    await m.queue.completeJob(pool, claimed!.id, "relogio");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "relogio", err);
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

  // O fuso da org é MANAUS — é o que separa esta coluna do knob de pacing.
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone)
     values ($1,'relogio-do-turno','Relogio do Turno','Relogio do Turno','America/Manaus')
     on conflict (id) do update set timezone = excluded.timezone`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead do Relogio','+5592900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'relogio-do-turno-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, dá pra marcar quinta?','external_device', now())
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

beforeEach(() => {
  enviados = [];
  promptsVistos = [];
});

describe("o prompt do turno carrega a data de hoje", () => {
  it("a abertura leva dia da semana, data e hora — no fuso da ORGANIZAÇÃO", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueGravaOPrompt(), INSTANTE));

    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
    // O turno chama o modelo duas vezes (resposta + checkpoint); o bloco tem de
    // estar na PRIMEIRA, que é a que decide o que fazer com o pedido do lead.
    expect(promptsVistos.length).toBeGreaterThan(0);
    expect(promptsVistos[0]).toContain("## Agora");
    expect(promptsVistos[0]).toContain(ESPERADO_MANAUS);
  });

  it("NÃO usa o fuso do pacing — a org é de Manaus e o canal não tem knob", async () => {
    // Com a fonte trocada por `channel_knobs.timezone`, o bloco diria a hora de
    // São Paulo (o default do pacing) e este caso é o único que reprova.
    await rodaTurno(montaHandler(modeloQueGravaOPrompt(), INSTANTE));

    expect(promptsVistos[0]).not.toContain(BLOCO_DO_PACING);
    expect(promptsVistos[0]).not.toContain("America/Sao_Paulo");
  });

  it("o instante absoluto vai junto — é o formato que as ferramentas de agenda exigem", async () => {
    await rodaTurno(montaHandler(modeloQueGravaOPrompt(), INSTANTE));

    expect(promptsVistos[0]).toContain("instante_absoluto: 2026-09-04T17:30:00.000Z");
  });
});
