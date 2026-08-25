import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A JANELA DE HORÁRIO É DECIDIDA PELO RELÓGIO INJETADO — nunca pelo de parede.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * `InboundTurnDeps.clock` documenta o próprio uso: "a janela horária do gate
 * anti-ban é avaliada nele. Default `() => new Date()`; os testes fixam um
 * instante dentro da janela para determinismo."
 *
 * O gate lia `new Date()` direto, contra esse contrato. O efeito não era um
 * teste frouxo: era um CHECK OBRIGATÓRIO (`invariants`) que dependia da hora
 * em que alguém abrisse o PR — reprovava entre 22h e 7h, passava no resto do
 * dia. Medido em 2026-08-24, mesmo commit, mesma máquina, com o conserto no
 * meio: 22:48 BRT sem o conserto → 3 casos de
 * `limite-de-envios-por-turno.test.ts` reprovados; 22:50 BRT com ele → verdes.
 * As sete rodadas verdes da `main` naquele dia caíram todas entre 09:58 e
 * 15:14 BRT: o defeito viveu escondido no horário comercial de quem trabalha
 * neste repo.
 *
 * ─── Por que um arquivo NOVO, e não mais casos no arquivo vizinho ───────────
 *
 * `tests/invariants/**` é congelado (`loop/hooks/freeze-invariants.sh`):
 * acrescentar arquivo é permitido, modificar um existente é bloqueado. A regra
 * está certa e é ela que impede o movimento "invariante incômodo → editar
 * invariante". Acrescentar é o caminho sancionado — e aqui ele também é a
 * separação certa: o vizinho mede o TETO DE ENVIOS por turno e fixa o relógio
 * só para o horário não atrapalhar; este mede o HORÁRIO em si.
 *
 * ─── Por que DOIS casos, e não só o que pegaria o defeito ───────────────────
 *
 * Os casos do vizinho injetam um instante DENTRO da janela. Com o defeito de
 * volta, eles só reprovam À NOITE — uma guarda que dorme das 7h às 22h, que é
 * justamente quando o time trabalha. O primeiro caso daqui é o espelho: injeta
 * um instante FORA e exige o adiamento, então reprova DE DIA. Medido,
 * sabotando o conserto nas duas condições:
 *
 *                      vizinho (3)   "fora→adia" (aqui)  "dentro→corre" (aqui)
 *   defeito à noite      PEGAM       passa (motivo         PEGA
 *                                     errado)
 *   defeito de dia       passam       PEGA                 passa
 *                        (motivo
 *                         errado)
 *
 * De dia, o primeiro caso daqui é a ÚNICA coisa entre o defeito e um CI verde.
 * O segundo existe pela razão oposta: um gate que adiasse SEMPRE também
 * satisfaria o primeiro, e "adia sempre" é outro jeito de o produto emudecer.
 *
 * Harness igual ao do vizinho: handler real, modelo fake, canal que CAPTURA em
 * vez de enviar, `sleep` no-op. Os ids são PRÓPRIOS: o `setupFile` recria o
 * banco por arquivo, mas ids distintos deixam o log legível quando os dois
 * arquivos aparecem na mesma corrida.
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

const ORG = "dddddddd-0000-4000-8000-0000000000a1";
const CONTACT = "dddddddd-0000-4000-8000-0000000000a2";
const SESSION = "dddddddd-0000-4000-8000-0000000000a3";
const CONV = "dddddddd-0000-4000-8000-0000000000a4";
const MSG = "dddddddd-0000-4000-8000-0000000000a5";
const CRM_EVENT = "dddddddd-0000-4000-8000-0000000000a6";

/** Terça, 15h BRT — dentro da janela anti-ban padrão (7h–22h). */
const DENTRO_DA_JANELA = new Date("2026-07-28T18:00:00Z");
/** Terça, 3h BRT — fora dela, com folga dos dois lados. */
const FORA_DA_JANELA = new Date("2026-07-28T06:00:00Z");

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
 * Modelo fake que manda UMA mensagem e encerra. `rotulo` é único por caso: os
 * dois compartilham a mesma conversa, e o gate `spinning` veta corpo repetido
 * entre turnos — sem o rótulo, o segundo caso seria bloqueado por um motivo
 * que não é o deste arquivo.
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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "janela", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "janela" });
    await m.queue.completeJob(pool, claimed!.id, "janela");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "janela", err);
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
     values ($1,'janela-relogio','Janela Relogio','Janela Relogio') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead da Janela','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'janela-relogio-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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

beforeEach(() => {
  enviados = [];
});

describe("a janela de horário é decidida pelo relógio injetado", () => {
  it("relógio FORA da janela: o turno é adiado, não importa a hora real", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueManda("noturno"), FORA_DA_JANELA));

    // Adiado, não gasto: `JobSettledError` é o contrato de "o run já dispôs do
    // job". Quem escreveu às 3h é atendido às 7h — e nada sai agora.
    expect(erro).not.toBeNull();
    expect(String(erro?.message)).toMatch(/fora da janela anti-ban/);
    expect(enviados).toHaveLength(0);
  });

  it("relógio DENTRO da janela: o turno corre — o gate não vira muro", async () => {
    const erro = await rodaTurno(montaHandler(modeloQueManda("diurno"), DENTRO_DA_JANELA));

    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
  });
});
