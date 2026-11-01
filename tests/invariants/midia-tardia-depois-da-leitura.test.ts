import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as MidiaDerivavel from "@/lib/agent-engine/edge/crm/midia-derivavel";
import type * as TurnoJaRespondido from "@/lib/agent-engine/agent/turno-ja-respondido";
import type * as Drain from "@/lib/agent-engine/edge/crm/drain";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * A MÍDIA QUE CHEGA DEPOIS DA ÚLTIMA LEITURA DO CONTEXTO (#3845).
 *
 * O #3841 fez o turno esperar a derivação da mídia que chega DURANTE o turno.
 * Ficou declarado, no próprio PR, o caso seguinte: a mídia entra DEPOIS da
 * última leitura do contexto e o modelo não relê (`get_lead_context`) — a
 * resposta sai sem ver aquele áudio.
 *
 * Este arquivo MEDE a janela em que isso pode acontecer, com os carimbos que o
 * próprio código grava (`messages.created_at` de chegada e `job_queue.payload.
 * ultima_inbound_vista_em` da anotação) e com o instante das consultas que
 * decidem o envio, no caminho de produção: job `inbound_turn` →
 * `createInboundTurnHandler` → `runAgentTurn`, contra Postgres real e modelo
 * fake. Quatro fatos são medidos:
 *
 *  0. a régua `midiaDerivavelPendente` — que decide se o turno espera e se o
 *     drain adia — VÊ a mídia pendente neste banco. (Ela não via: o driver
 *     entrega `timestamptz` como `Date` e a guarda exigia `string`. Dublê de
 *     pool devolve string e escondia a fronteira.)
 *
 *  1. mídia que chega DEPOIS da leitura (durante a chamada do modelo): a
 *     resposta NÃO sai — `respostaFicouObsoleta` (teto de 120 s, ligada por
 *     padrão) descarta o envio e a mensagem nova ganha turno próprio. É o caso
 *     que a issue descreve, e ele está coberto ANTES deste arquivo existir.
 *  2. mídia que chega entre a última checagem de derivação e a ANOTAÇÃO do
 *     turno (um round-trip): a anotação passava a prometer uma mídia que o
 *     turno leu como `[audio]`, e a régua `ultimaInboundJaRespondida` calava o
 *     turno dela — a resposta saía sem o texto E ninguém respondia ao áudio.
 *     É a janela declarada no próprio #3841 ("fica coberto sem texto — janela
 *     rara, aceita; fecha com o UPDATE filtrando media_derived_status se um dia
 *     for medida"). Este arquivo é a medição, e o caso 2 é o teste que
 *     discrimina: reprova na base e passa com a anotação filtrada.
 *  3. mídia que derivou durante a espera continua prometida pela anotação —
 *     sem isso o turno dela responderia de novo, e o preço do conserto seria
 *     resposta dupla em todo áudio que chega no meio do turno.
 *
 * O carimbo que decide não é a DURAÇÃO da janela: `respostaFicouObsoleta` e
 * `ultimaInboundJaRespondida` comparam `created_at` com a anotação. Qualquer
 * mídia com carimbo posterior à anotação é pega, tenha a janela 1 s ou 120 s.
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
  max: 4,
});

const ORG = "eeb20000-0000-4000-8000-000000000001";
const CONTACT = "eeb20000-0000-4000-8000-000000000002";
const SESSION = "eeb20000-0000-4000-8000-000000000003";
const CONV = "eeb20000-0000-4000-8000-000000000004";

/** Mesmo teto do turno vizinho (`resposta-descartada-tem-quem-responda`). */
const TETO = 120_000;
const PERGUNTA = "Tudo bem?";
const TRANSCRICAO = "oi, o quarto estava sujo e ninguém apareceu para limpar";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  midiaDerivavelPendente: typeof MidiaDerivavel.midiaDerivavelPendente;
  regua: typeof TurnoJaRespondido;
  queue: typeof Queue;
  drainTick: typeof Drain.drainTick;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados = 0;

/** Carimbos de parede do caminho real — é a medição que o arquivo reporta. */
const carimbos: { leitura: number | null; anotacao: number | null; envio: number | null } = {
  leitura: null,
  anotacao: null,
  envio: null,
};

const haSegundos = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

/** Inbound de TEXTO — o que o cliente escreve. */
async function inbound(texto: string, em: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',$7,$7)`,
    [id, ORG, CONV, SESSION, CONTACT, texto, em],
  );
  return id;
}

/**
 * Inbound de ÁUDIO — `body` nulo, `media_url` presente (pré-condição de toda a
 * esteira) e derivação ainda não terminada, que é como a ingestão grava.
 */
async function audio(em: string, status: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, media_url, media_mime, media_derived_status, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'audio','inbound','delivered',null,$6,'audio/ogg',$7,'external_device',$8,$8)`,
    [id, ORG, CONV, SESSION, CONTACT, `https://cdn.example/${id}.ogg`, status, em],
  );
  return id;
}

/** O worker de derivação terminou: texto pronto, status terminal. */
async function derivar(id: string): Promise<void> {
  await pool.query(
    `update messages set media_derived_status = 'ready', media_derived_text = $2 where id = $1`,
    [id, TRANSCRICAO],
  );
}

/**
 * Pool espião — o mesmo do banco, com dois poderes de BANCADA:
 *
 *  - CARIMBA o instante da leitura que alimenta o prompt (`media_mime`), da
 *    anotação (`ultima_inbound_vista_em`) e da guarda que decide o envio
 *    (`respostaFicouObsoleta`), em ms de parede, na ordem real das consultas;
 *  - INJETA, se pedido, uma mensagem ANTES de uma query escolhida — é como este
 *    arquivo reproduz, sem corrida, a janela de um round-trip entre a última
 *    checagem de derivação e a anotação do turno.
 */
function poolEspiao(
  real: pg.Pool,
  injecao: { antesDe: "sem_midia" | "anotacao"; executar: () => Promise<void> } | null,
): pg.Pool {
  let injetou = false;
  let anotacoes = 0;
  const queryOriginal = real.query.bind(real) as unknown as (
    sql: unknown,
    params?: unknown,
  ) => Promise<unknown>;
  return new Proxy(real, {
    get(alvo, prop, recv) {
      if (prop === "query") {
        return async (sql: unknown, params?: unknown) => {
          const texto = typeof sql === "string" ? sql : "";
          // `ultima_inbound_vista_em` também aparece na LEITURA da régua
          // (`ultimaInboundJaRespondida`); a anotação é o UPDATE.
          const ehAnotacao =
            texto.includes("update job_queue") && texto.includes("ultima_inbound_vista_em");
          // Só a GUARDA de resposta obsoleta: `send_ledger` também é consultado
          // antes da leitura (resgate de envio pendente) e carimbaria cedo.
          const ehEnvio = texto.includes("as obsoleta");
          // A leitura da CONVERSA que alimenta o prompt (a única que traz o
          // histórico com mídia) — `media_mime` sozinho também aparece em outras
          // consultas, e por isso o discriminante é o par de colunas.
          const ehLeitura = texto.includes("media_storage_path, media_mime");
          const ehChecagemDeMidia =
            texto.includes("media_derived_status") && texto.includes("media_url is not null");
          if (ehLeitura && carimbos.leitura === null) carimbos.leitura = Date.now();
          if (ehEnvio && carimbos.envio === null) carimbos.envio = Date.now();
          if (ehAnotacao) {
            anotacoes += 1;
            // A SEGUNDA anotação é a do meio do turno, logo depois de a última
            // checagem de derivação voltar "nada pendente": é a janela de um
            // round-trip que este arquivo mede. A primeira é a do começo do
            // turno, e mídia que chega ali é lida depois da espera.
            if (injecao !== null && !injetou && injecao.antesDe === "anotacao" && anotacoes === 2) {
              injetou = true;
              await injecao.executar();
            }
            carimbos.anotacao = Date.now();
          }
          if (injecao !== null && !injetou && injecao.antesDe === "sem_midia" && ehChecagemDeMidia) {
            injetou = true;
            await injecao.executar();
          }
          return queryOriginal(sql, params);
        };
      }
      const valor = Reflect.get(alvo, prop, recv);
      return typeof valor === "function" ? valor.bind(alvo) : valor;
    },
  }) as pg.Pool;
}

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Modelo fake: 1ª chamada pede `send_message`; depois encerra. */
function modelo(onPrimeiraChamada?: () => Promise<void> | void) {
  let chamadas = 0;
  return async () => {
    chamadas += 1;
    if (chamadas === 1) {
      if (onPrimeiraChamada !== undefined) await onPrimeiraChamada();
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

/**
 * Reivindica o próximo job e o roda pelo caminho de produção, com o pool
 * espião (carimbos + injeção) e o `sleep` do turno como gancho da derivação.
 */
async function rodarJob(
  jobId: string,
  fake: ReturnType<typeof modelo>,
  opcoes: {
    injecao?: { antesDe: "sem_midia" | "anotacao"; executar: () => Promise<void> } | null;
    aoDormir?: () => Promise<void> | void;
  } = {},
): Promise<void> {
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "midia-tardia", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "chave-de-teste" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      respostaObsoletaTetoMs: TETO,
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
    sleep: async () => {
      if (opcoes.aoDormir !== undefined) await opcoes.aoDormir();
    },
  });
  await handler(claimed!, poolEspiao(pool, opcoes.injecao ?? null), { workerId: "midia-tardia" });
  await m.queue.completeJob(pool, claimed!.id, "midia-tardia");
}

/** A anotação do turno — o carimbo que decide se o job da mídia se cala. */
async function anotacaoDoJob(jobId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ em: Date | null }>(
    `select (payload->>'ultima_inbound_vista_em')::timestamptz as em
       from job_queue where organization_id = $1 and id = $2`,
    [ORG, jobId],
  );
  return rows[0]?.em ?? null;
}

async function jobDoTurno(inboundMessageId: string): Promise<string> {
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: inboundMessageId,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  return job.id;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    midiaDerivavelPendente: (await import("@/lib/agent-engine/edge/crm/midia-derivavel"))
      .midiaDerivavelPendente,
    regua: await import("@/lib/agent-engine/agent/turno-ja-respondido"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    drainTick: (await import("@/lib/agent-engine/edge/crm/drain")).drainTick,
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'midia-tardia','Midia Tardia','Midia Tardia') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'midia-tardia-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
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
  enviados = 0;
  carimbos.leitura = null;
  carimbos.anotacao = null;
  carimbos.envio = null;
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Cliente de teste','+5511988887777')`,
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

describe("#3845 — a mídia que chega depois da última leitura do contexto", () => {
  it("MEDIÇÃO 0: a régua da mídia pendente contra Postgres REAL vê o áudio que chegou", async () => {
    // A régua é a peça que decide se o turno espera a derivação (#3841) e se o
    // drain adia o despacho. Ela recebe `created_at as quando` — e o driver
    // devolve `timestamptz` como `Date`, não como string. Este caso mede isso no
    // banco de verdade: dublê de pool devolve string e esconde a fronteira.
    const id = await audio(new Date().toISOString());
    const pendente = await m.midiaDerivavelPendente(pool, {
      organizationId: ORG,
      conversationId: CONV,
    });
    const { rows } = await pool.query<{ tipo: string }>(
      `select pg_typeof(created_at)::text as tipo from messages where id = $1`,
      [id],
    );
    process.stderr.write(
      `[#3845] medição 0: midiaDerivavelPendente = ${
        pendente === null ? "null" : JSON.stringify(pendente)
      }; created_at é ${rows[0]?.tipo}\n`,
    );
    expect(pendente, "a régua não viu o áudio pendente que está na conversa").not.toBeNull();
  });

  it("MEDIÇÃO 1: áudio que chega DEPOIS da leitura (na chamada do modelo) não é respondido às cegas", async () => {
    // O cliente escreve "Oi" e "Tudo bem?"; o turno lê a conversa e o áudio
    // chega durante o tempo do modelo — o caso literal da issue.
    await inbound("Oi", haSegundos(20));
    const pergunta = await inbound(PERGUNTA, haSegundos(15));
    const job = await jobDoTurno(pergunta);

    let chegouEm: Date | null = null;
    await rodarJob(job, modelo(async () => {
      chegouEm = new Date();
      await audio(new Date().toISOString());
    }));

    // NADA saiu: a resposta foi descartada por `respostaFicouObsoleta`, e a
    // mensagem nova tem turno próprio (é ele que lê a transcrição).
    expect(enviados).toBe(0);
    const anotacao = await anotacaoDoJob(job);
    expect(anotacao, "o turno não anotou o que viu").not.toBeNull();
    expect(chegouEm!.getTime(), "o áudio chegou antes da anotação — fixture errada").toBeGreaterThan(
      anotacao!.getTime(),
    );
    // Carimbos de parede desta rodada (bancada): leitura do contexto → tentativa
    // de envio. É o PISO da janela: o tempo do modelo é o termo que domina.
    process.stderr.write(
      `[#3845] medição 1: leitura→tentativa de envio = ${
        carimbos.envio !== null && carimbos.leitura !== null
          ? carimbos.envio - carimbos.leitura
          : "n/a"
      } ms (modelo fake, sem latência de provedor); anotação ${anotacao!.toISOString()} < áudio ${chegouEm!.toISOString()}\n`,
    );
  });

  it("CASO DA JANELA: áudio entre a última checagem de derivação e a anotação não é prometido pela anotação", async () => {
    // O cliente já mandou um áudio; o turno espera a derivação (é o #3841).
    await inbound("Oi", haSegundos(20));
    const pergunta = await inbound(PERGUNTA, haSegundos(15));
    const audioEsperado = await audio(haSegundos(3));
    const job = await jobDoTurno(pergunta);

    // Um SEGUNDO áudio chega exatamente no round-trip entre a última checagem de
    // derivação (que volta "nada pendente") e o UPDATE da anotação: chega antes
    // de o turno ler a conversa, e a derivação dele nem foi pedida.
    let tardioEm: Date | null = null;
    let tardioId = "";
    let jaDerivou = false;
    await rodarJob(job, modelo(), {
      injecao: {
        antesDe: "anotacao",
        executar: async () => {
          tardioEm = new Date();
          tardioId = await audio(tardioEm.toISOString());
        },
      },
      aoDormir: async () => {
        if (!jaDerivou) {
          jaDerivou = true;
          await derivar(audioEsperado);
        }
      },
    });

    // A DOR primeiro: a resposta saiu escrita antes de o áudio tardio ter texto.
    // (Na base o turno nem chega a esperar a derivação — a régua não vê mídia
    // pendente —, então é aqui que o vermelho aparece primeiro.)
    expect(
      enviados,
      "saiu resposta escrita antes de o áudio tardio ter texto — o cliente recebe uma resposta que ignora o que acabou de mandar",
    ).toBe(0);

    expect(tardioId, "a injeção da bancada não rodou").not.toBe("");
    const anotacao = await anotacaoDoJob(job);
    expect(anotacao).not.toBeNull();

    // A anotação promete o que o turno leu COM TEXTO (o áudio derivado durante a
    // espera) e NÃO promete o que ele leu como `[audio]` (o tardio). Prometer o
    // tardio cala o turno dele por `ultimaInboundJaRespondida`: a resposta sai
    // sem a transcrição E ninguém responde ao áudio.
    expect(anotacao!.getTime(), "a anotação prometeu um áudio que o turno não leu").toBeLessThan(
      tardioEm!.getTime(),
    );

    // E o efeito medido: o turno que leria o tardio NÃO está calado.
    expect(
      await m.regua.ultimaInboundJaRespondida(pool, {
        organizationId: ORG,
        contactId: CONTACT,
        conversationId: CONV,
        jobId: crypto.randomUUID(),
      }),
      "o job do áudio tardio foi calado — o cliente recebeu resposta sem o texto e ninguém respondeu ao áudio",
    ).toBe(false);

    process.stderr.write(
      `[#3845] medição 2: janela anotação→leitura = ${
        carimbos.leitura !== null && carimbos.anotacao !== null
          ? carimbos.leitura - carimbos.anotacao
          : "n/a"
      } ms (um round-trip ao Postgres local); áudio tardio ${tardioEm!.toISOString()} > anotação ${anotacao!.toISOString()}\n`,
    );
  });

  it("SEM REGRESSÃO: áudio que derivou durante a espera continua prometido (sem resposta dupla)", async () => {
    await inbound("Oi", haSegundos(20));
    const pergunta = await inbound(PERGUNTA, haSegundos(15));
    const audioEsperado = await audio(haSegundos(3));
    const job = await jobDoTurno(pergunta);

    let jaDerivou = false;
    await rodarJob(job, modelo(), {
      aoDormir: async () => {
        if (!jaDerivou) {
          jaDerivou = true;
          await derivar(audioEsperado);
        }
      },
    });

    const { rows } = await pool.query<{ em: Date }>(
      `select created_at as em from messages where id = $1`,
      [audioEsperado],
    );
    const anotacao = await anotacaoDoJob(job);
    // O turno leu a TRANSCRIÇÃO: prometer o áudio é correto, e é o que impede o
    // job dele de responder de novo (resposta dupla).
    expect(anotacao!.getTime()).toBeGreaterThanOrEqual(rows[0]!.em.getTime());
    expect(enviados).toBe(1);

    // MEDIÇÃO 3 — a janela da issue, nos instantes das consultas do próprio
    // turno: da anotação (o turno declara o que leu, imediatamente antes de montar
    // o prompt) até a guarda `respostaFicouObsoleta`, que é o statement que
    // decide se o envio sai. Modelo fake, sem latência de provedor: é o PISO.
    process.stderr.write(
      `[#3845] medição 3: anotação→guarda de envio = ${
        carimbos.envio !== null && carimbos.anotacao !== null
          ? carimbos.envio - carimbos.anotacao
          : "n/a"
      } ms; leitura→guarda = ${
        carimbos.envio !== null && carimbos.leitura !== null
          ? carimbos.envio - carimbos.leitura
          : "n/a"
      } ms (piso, modelo fake sem latência)\n`,
    );
  });
});
