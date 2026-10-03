import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as TurnoJaRespondido from "@/lib/agent-engine/agent/turno-ja-respondido";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A MESMA mensagem do cliente não recebe duas respostas do agente.
 *
 * O caso medido em produção (2026-09-24) está no cabeçalho de
 * `lib/agent-engine/agent/turno-ja-respondido.ts`: o turno do "Sim" começou
 * depois de o "365" chegar, respondeu ao 365, e o job do próprio 365 respondeu
 * de novo 73 s depois.
 *
 * Dois blocos:
 *   1. a RÉGUA (`ultimaInboundJaRespondida`) contra o banco, caso a caso —
 *      inclusive os três em que calar seria o defeito oposto (turno que leu antes
 *      da mensagem chegar, turno que viu e não enviou, mensagem nova depois);
 *   2. a PORTA: o handler real de `inbound_turn` não chama o modelo quando outro
 *      turno já respondeu, e anota no próprio job o que viu quando segue.
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

const ORG = "ddd10000-0000-4000-8000-000000000001";
const CONTACT = "ddd10000-0000-4000-8000-000000000002";
const SESSION = "ddd10000-0000-4000-8000-000000000003";
const CONV = "ddd10000-0000-4000-8000-000000000004";
const OUTRA_CONV = "ddd10000-0000-4000-8000-000000000005";
// Outro número: o schema só admite uma conversa 1:1 por contato e número.
const OUTRA_SESSION = "ddd10000-0000-4000-8000-000000000006";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  regua: typeof TurnoJaRespondido;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let modeloChamado = 0;
let enviados = 0;

const T = (hhmmss: string): string => `2026-09-24T14:${hhmmss}-03:00`;

async function inbound(texto: string, em: string, conv = CONV): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',$7,$7)`,
    [id, ORG, conv, conv === CONV ? SESSION : OUTRA_SESSION, CONTACT, texto, em],
  );
  return id;
}

/**
 * Um turno de resposta JÁ TERMINADO: o job, o que ele anotou ter visto
 * (`null` = turno anterior a esta mudança, sem anotação) e — se `envio` vier —
 * a resposta que ele mandou, com a linha do `send_ledger`.
 */
async function turnoTerminado(opts: {
  vistoAte: string | null;
  envio?: { status: "accepted" | "queued" | "vetoed" | "failed"; em: string; conv?: string };
  kind?: "inbound_turn" | "followup_turn";
}): Promise<string> {
  const jobId = crypto.randomUUID();
  const payload: Record<string, unknown> = { conversation_id: CONV };
  if (opts.vistoAte !== null) payload.ultima_inbound_vista_em = opts.vistoAte;
  await pool.query(
    `insert into job_queue (id, organization_id, contact_id, kind, payload, status, attempts)
     values ($1,$2,$3,$4,$5,'done',1)`,
    [jobId, ORG, CONTACT, opts.kind ?? "inbound_turn", payload],
  );
  if (opts.envio) {
    const msgId = crypto.randomUUID();
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'text','outbound','sent','Perfeito…','ai',$6,$6)`,
      [msgId, ORG, opts.envio.conv ?? CONV, opts.envio.conv === OUTRA_CONV ? OUTRA_SESSION : SESSION, CONTACT, opts.envio.em],
    );
    await pool.query(
      `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status, crm_message_id)
       values ($1,$2,$3,1,'h',$4,$5)`,
      [ORG, CONTACT, jobId, opts.envio.status, msgId],
    );
  }
  return jobId;
}

const alvo = (jobId: string, conversationId = CONV) => ({
  organizationId: ORG,
  contactId: CONTACT,
  conversationId,
  jobId,
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function montaHandler() {
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
    registry: m.createFakeRegistry((async () => {
      modeloChamado += 1;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              commitments: [],
              objections: [],
              next_action: null,
              rolling_summary: "turno de teste",
            }),
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }) as never),
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
    // Dentro da janela anti-ban (7h-22h BRT), como os vizinhos.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

/** Enfileira, reivindica e roda o handler real para a inbound `msgId`. */
async function rodaHandler(msgId: string): Promise<string> {
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msgId,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "dup", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await montaHandler()(claimed!, pool, { workerId: "dup" });
    await m.queue.completeJob(pool, claimed!.id, "dup");
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "dup", err);
    throw err;
  }
  return job.id;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    regua: await import("@/lib/agent-engine/agent/turno-ja-respondido"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'turno-duplicado','Turno Duplicado','Turno Duplicado') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'turno-duplicado-session','WORKING','\\x00'::bytea),
            ($3,$2,'turno-duplicado-outra','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG, OUTRA_SESSION],
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
  modeloChamado = 0;
  enviados = 0;
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Tina de teste','+5511900000888')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false), ($5,$2,$3,$6,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION, OUTRA_CONV, OUTRA_SESSION],
  );
});

describe("a régua: outro turno já viu e respondeu a última mensagem do cliente?", () => {
  it("o caso medido — o turno anterior leu o 365 e respondeu: o job do 365 cala", async () => {
    await inbound("Sim", T("02:39"));
    await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({ vistoAte: T("04:04"), envio: { status: "accepted", em: T("04:26") } });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(true);
  });

  it("envio ainda na fila do WhatsApp (queued) também é resposta", async () => {
    await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({ vistoAte: T("04:04"), envio: { status: "queued", em: T("04:26") } });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(true);
  });

  it("turno que leu ANTES de a mensagem chegar e enviou depois não cala o turno dela", async () => {
    await inbound("Sim", T("02:39"));
    await inbound("365,00 2x na semana", T("04:04"));
    // Viu só até o "Sim"; a resposta saiu depois do 365, mas sem tê-lo lido.
    await turnoTerminado({ vistoAte: T("02:39"), envio: { status: "accepted", em: T("04:26") } });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(false);
  });

  it("turno que viu a mensagem mas não enviou (veto ou falha) não cala o seguinte", async () => {
    await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({ vistoAte: T("04:04"), envio: { status: "vetoed", em: T("04:26") } });
    await turnoTerminado({ vistoAte: T("04:04"), envio: { status: "failed", em: T("04:27") } });
    await turnoTerminado({ vistoAte: T("04:04") });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(false);
  });

  it("mensagem nova do cliente depois da resposta: responde de novo", async () => {
    await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({ vistoAte: T("04:04"), envio: { status: "accepted", em: T("04:26") } });
    await inbound("e como funciona o teste?", T("04:40"));
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(false);
  });

  it("o próprio job não conta (retentativa depois de enviar é assunto do send_ledger)", async () => {
    await inbound("365,00 2x na semana", T("04:04"));
    const proprio = await turnoTerminado({
      vistoAte: T("04:04"),
      envio: { status: "accepted", em: T("04:26") },
    });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(proprio))).toBe(false);
  });

  it("resposta enviada em OUTRA conversa do contato não conta", async () => {
    await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({
      vistoAte: T("04:04"),
      envio: { status: "accepted", em: T("04:26"), conv: OUTRA_CONV },
    });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(false);
  });

  it("follow-up não é resposta à pergunta do cliente", async () => {
    await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({
      vistoAte: T("04:04"),
      envio: { status: "accepted", em: T("04:26") },
      kind: "followup_turn",
    });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(false);
  });

  it("job anterior a esta mudança (sem anotação) não cala ninguém", async () => {
    await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({ vistoAte: null, envio: { status: "accepted", em: T("04:26") } });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(false);
  });

  it("conversa sem inbound: nada a calar", async () => {
    await turnoTerminado({ vistoAte: T("04:04"), envio: { status: "accepted", em: T("04:26") } });
    expect(await m.regua.ultimaInboundJaRespondida(pool, alvo(crypto.randomUUID()))).toBe(false);
  });

  it("a anotação grava a inbound mais nova e não apaga outra chave do payload", async () => {
    await inbound("Sim", T("02:39"));
    await inbound("365,00 2x na semana", T("04:04"));
    await inbound("de outra conversa", T("04:30"), OUTRA_CONV);
    const jobId = await turnoTerminado({ vistoAte: null });
    await pool.query(
      `update job_queue set payload = payload || '{"held_run_after":"x"}' where id = $1`,
      [jobId],
    );
    await m.regua.anotarUltimaInboundVista(pool, alvo(jobId));
    const { rows } = await pool.query<{ visto: string; held: string | null; conv: string | null }>(
      `select (payload->>'ultima_inbound_vista_em')::timestamptz = $2::timestamptz as visto,
              payload->>'held_run_after' as held, payload->>'conversation_id' as conv
         from job_queue where id = $1`,
      [jobId, T("04:04")],
    );
    expect(rows[0]).toEqual({ visto: true, held: "x", conv: CONV });
  });
});

describe("a porta: o handler real de inbound_turn", () => {
  it("não chama o modelo nem envia quando outro turno já respondeu à última mensagem", async () => {
    await inbound("Sim", T("02:39"));
    const msg365 = await inbound("365,00 2x na semana", T("04:04"));
    await turnoTerminado({ vistoAte: T("04:04"), envio: { status: "accepted", em: T("04:26") } });

    await rodaHandler(msg365);

    expect(modeloChamado).toBe(0);
    expect(enviados).toBe(0);
  });

  it("controle: sem resposta anterior, o turno roda e anota no próprio job o que viu", async () => {
    await inbound("Sim", T("02:39"));
    const msg365 = await inbound("365,00 2x na semana", T("04:04"));
    // Quem respondeu leu só até o "Sim": o 365 continua sem resposta.
    await turnoTerminado({ vistoAte: T("02:39"), envio: { status: "accepted", em: T("04:26") } });

    const jobId = await rodaHandler(msg365);

    expect(modeloChamado).toBeGreaterThan(0);
    const { rows } = await pool.query<{ ok: boolean }>(
      `select (payload->>'ultima_inbound_vista_em')::timestamptz = $2::timestamptz as ok
         from job_queue where id = $1`,
      [jobId, T("04:04")],
    );
    expect(rows[0]?.ok).toBe(true);
  });
});

describe("resposta obsoleta: o cliente escreveu de novo enquanto o turno pensava?", () => {
  // A régua compara com `now()`, então os instantes são relativos ao relógio real.
  const haSegundos = (s: number): string => new Date(Date.now() - s * 1000).toISOString();
  const TETO = 120_000;

  /** Job em andamento que anotou ter visto até `vistoAte`. */
  async function turnoEmAndamento(vistoAte: string | null): Promise<string> {
    return turnoTerminado({ vistoAte });
  }

  it("o caso medido — leu os cumprimentos, a pergunta chegou durante o turno: não envia", async () => {
    await inbound("Oi", haSegundos(40));
    await inbound("Boa tarde", haSegundos(36));
    const job = await turnoEmAndamento(haSegundos(36));
    await inbound("Eu precisava comprar um pneu para a minha D01", haSegundos(15));
    expect(await m.regua.respostaFicouObsoleta(pool, alvo(job), TETO)).toBe(true);
  });

  it("nada chegou depois da leitura: envia", async () => {
    await inbound("Oi", haSegundos(40));
    const job = await turnoEmAndamento(haSegundos(40));
    expect(await m.regua.respostaFicouObsoleta(pool, alvo(job), TETO)).toBe(false);
  });

  it("cliente sem resposta há mais que o teto: envia mesmo desatualizada (silêncio é pior)", async () => {
    await inbound("Oi", haSegundos(300));
    const job = await turnoEmAndamento(haSegundos(300));
    await inbound("alguém aí?", haSegundos(10));
    expect(await m.regua.respostaFicouObsoleta(pool, alvo(job), TETO)).toBe(false);
  });

  it("o teto conta desde a última resposta nossa, não desde a primeira mensagem da conversa", async () => {
    await inbound("mensagem de ontem", haSegundos(86_400));
    await turnoTerminado({ vistoAte: haSegundos(86_400), envio: { status: "accepted", em: haSegundos(86_000) } });
    await inbound("Oi de novo", haSegundos(30));
    const job = await turnoEmAndamento(haSegundos(30));
    await inbound("queria marcar revisão", haSegundos(5));
    expect(await m.regua.respostaFicouObsoleta(pool, alvo(job), TETO)).toBe(true);
  });

  it("mensagem nova em OUTRA conversa do contato não torna esta obsoleta", async () => {
    await inbound("Oi", haSegundos(40));
    const job = await turnoEmAndamento(haSegundos(40));
    await inbound("em outro número", haSegundos(5), OUTRA_CONV);
    expect(await m.regua.respostaFicouObsoleta(pool, alvo(job), TETO)).toBe(false);
  });

  it("job sem anotação (follow-up, ou anterior à mudança) nunca é obsoleto", async () => {
    await inbound("Oi", haSegundos(40));
    const job = await turnoEmAndamento(null);
    await inbound("pergunta", haSegundos(5));
    expect(await m.regua.respostaFicouObsoleta(pool, alvo(job), TETO)).toBe(false);
  });

  it("teto 0 desliga a régua", async () => {
    await inbound("Oi", haSegundos(40));
    const job = await turnoEmAndamento(haSegundos(40));
    await inbound("pergunta", haSegundos(5));
    expect(await m.regua.respostaFicouObsoleta(pool, alvo(job), 0)).toBe(false);
  });
});

describe("resposta obsoleta — a porta: o handler real não envia o que ficou desatualizado", () => {
  const haSegundos = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

  /**
   * Modelo fake: na 1ª chamada a pergunta do cliente CHEGA (como no caso medido,
   * durante os 10–40 s do modelo) e ele pede `send_message`; depois encerra.
   */
  function modeloQueDemora(resultados: unknown[]) {
    let chamadas = 0;
    return async (opts: { prompt?: unknown }) => {
      for (const msg of (opts.prompt ?? []) as Array<{ content?: unknown }>) {
        if (!Array.isArray(msg.content)) continue;
        for (const parte of msg.content as Array<Record<string, unknown>>) {
          if (parte.type === "tool-result") resultados.push(parte.output ?? parte);
        }
      }
      chamadas += 1;
      if (chamadas === 1) {
        await inbound("Eu precisava comprar um pneu para a minha D01", new Date().toISOString());
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "c1",
              toolName: "send_message",
              input: JSON.stringify({ body: "Tudo bem também! Como posso te ajudar?" }),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USO,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" }),
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    };
  }

  async function rodar(tetoMs: number): Promise<unknown[]> {
    const resultados: unknown[] = [];
    await inbound("Oi", haSegundos(20));
    const msg = await inbound("Tudo bem?", haSegundos(15));
    const { job } = await m.queue.enqueueJob(pool, ORG, {
      kind: "inbound_turn",
      leadId: CONTACT,
      payload: {
        conversation_id: CONV,
        contact_id: CONTACT,
        channel_session_id: SESSION,
        inbound_message_id: msg,
        crm_event_id: crypto.randomUUID(),
      },
      maxAttempts: 1,
    });
    const [claimed] = await m.queue.claimJobs(pool, { workerId: "obs", maxConcurrency: 1 });
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
        respostaObsoletaTetoMs: tetoMs,
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
      registry: m.createFakeRegistry(modeloQueDemora(resultados) as never),
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
    await handler(claimed!, pool, { workerId: "obs" });
    await m.queue.completeJob(pool, claimed!.id, "obs");
    return resultados;
  }

  it("a pergunta chegou enquanto o modelo pensava: a resposta desatualizada não sai", async () => {
    const resultados = await rodar(120_000);
    expect(enviados).toBe(0);
    expect(JSON.stringify(resultados)).toContain("resposta_obsoleta");
  });

  it("controle: com a régua desligada, a mesma cena envia (é o defeito de antes)", async () => {
    await rodar(0);
    expect(enviados).toBe(1);
  });
});

