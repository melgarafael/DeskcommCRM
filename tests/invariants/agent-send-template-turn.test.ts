import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import { abreJanelaDeEnvio } from "./janela-de-envio";

/**
 * O turno COMPLETO enviando template — o que `send-template-wiring.test.ts` declarava
 * como descoberto.
 *
 * ─── A estimativa errada que este arquivo desfaz ────────────────────────────
 * Eu havia declarado que provar isto exigiria "um harness que este repo não tem",
 * citando `case-reply-turn.test.ts`: *"não existe seam de harness pra rodar o núcleo
 * do turno (LLM + envio)"*. A frase era verdadeira quando escrita; a conclusão que
 * tirei dela, não.
 *
 * O que me fez errar: presumi que `openingContext` saía para o CRM por MCP. Ele não
 * sai — `getLeadContext` recebe o cfg como **`_cfg`**, com underscore, e lê o
 * Postgres direto. Os únicos usos do cliente Supabase no turno são
 * `read_skill_reference` (só se o modelo chamar a tool) e o enquadramento de mídia
 * (só se houver mídia). Nenhum dos dois entra num turno de texto.
 *
 * Com isso, os quatro seams que já existiam bastam: `registry` (modelo fake, via
 * `createFakeRegistry` — que estava definido e **sem nenhum consumidor**), `channel`
 * (adapter que captura em vez de enviar), `clock` e `sleep`.
 *
 * ─── O que só este arquivo prova ────────────────────────────────────────────
 * O guard de forma prova que `isTemplate: true` está escrito no código. Aqui a
 * mensagem inbound tem **30 horas** — a janela de 24h está fechada de verdade — e o
 * gate `messaging_window` **deixa passar**. É a diferença entre "a flag está lá" e
 * "a flag faz o que promete".
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

const ORG = "cccccccc-0000-4000-8000-000000000001";
const CONTACT = "cccccccc-0000-4000-8000-000000000002";
/** Sessão Cloud API — o canal que EXIGE template fora da janela. */
const SESSION_META = "cccccccc-0000-4000-8000-000000000003";
/** Sessão WAHA — o contraste: fala livre, e a tool nem deve existir. */
const SESSION_WAHA = "cccccccc-0000-4000-8000-000000000013";
const CONV = "cccccccc-0000-4000-8000-000000000004";
const CONV_WAHA = "cccccccc-0000-4000-8000-000000000014";
const MSG = "cccccccc-0000-4000-8000-000000000005";
const MSG_WAHA = "cccccccc-0000-4000-8000-000000000015";

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
     values ($1,'send-template-turn','Send Template Turn','Send Template Turn')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Template','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id,
                                   meta_waba_id, status, webhook_secret_encrypted)
     values ($1,$2,'meta_cloud','111','222','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION_META, ORG],
  );
  // Sem isto o turno é ADIADO fora de 7h–22h e este arquivo mede a janela em vez
  // do que ele diz medir — verde de dia, vermelho de madrugada. Ver o cabeçalho
  // de janela-de-envio.ts.
  await abreJanelaDeEnvio(pool, ORG, SESSION_META);
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1,$2,'waha','tpl-waha','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION_WAHA, ORG],
  );
  for (const [conv, sessao] of [
    [CONV, SESSION_META],
    [CONV_WAHA, SESSION_WAHA],
  ] as const) {
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'open',false) on conflict (id) do nothing`,
      [conv, ORG, CONTACT, sessao],
    );
  }
  // 30 HORAS: a janela de 24h está FECHADA. É o que dá sentido ao template — e o que
  // faria o gate `messaging_window` vetar um envio de texto livre.
  for (const [msg, conv, sessao] of [
    [MSG, CONV, SESSION_META],
    [MSG_WAHA, CONV_WAHA, SESSION_WAHA],
  ] as const) {
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi','external_device',
               now() - interval '30 hours')
       on conflict (id) do nothing`,
      [msg, ORG, conv, sessao, CONTACT],
    );
  }
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, name, language, status, category,
                                 components, parameter_format, contract_hash)
     values ($1,'222','retomada','pt_BR','APPROVED','MARKETING',
       '[{"type":"BODY","text":"Oi {{1}}, tudo certo?"}]'::jsonb,'POSITIONAL','h-aprovado')
     on conflict (organization_id, waba_id, name, language) do update set status = 'APPROVED'`,
    [ORG],
  );
  // O par do contraste: mesmo espelho, status que a Meta ainda não aprovou.
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, name, language, status, category,
                                 components, parameter_format, contract_hash)
     values ($1,'222','em_analise','pt_BR','PENDING','MARKETING',
       '[{"type":"BODY","text":"Oi {{1}}, tudo certo?"}]'::jsonb,'POSITIONAL','h-pendente')
     on conflict (organization_id, waba_id, name, language) do update set status = 'PENDING'`,
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

const ALVO_META = { conv: CONV, sessao: SESSION_META, msg: MSG, evento: "cccccccc-0000-4000-8000-000000000006" };
const ALVO_WAHA = { conv: CONV_WAHA, sessao: SESSION_WAHA, msg: MSG_WAHA, evento: "cccccccc-0000-4000-8000-000000000016" };

describe("turno completo — send_template com a janela de 24h FECHADA", () => {
  it("o template sai, com corpo renderizado e identidade preservada", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloQueChamaTemplate({ template_name: "retomada", language: "pt_BR", values: { "1": "Ana" } }),
      ),
      ALVO_META,
    );
    expect(erro).toBeNull();

    expect(enviados).toHaveLength(1);
    const envio = enviados[0]!;
    // O corpo é o template RENDERIZADO — é ele que os gates de conteúdo avaliaram e
    // é ele que o contato vai ler.
    expect(envio.body).toBe("Oi Ana, tudo certo?");
    // E a identidade de template acompanha: sem isso o banco grava `type: 'text'` e
    // perde custo (cobrado por entrega) e conformidade (fora da janela, só template).
    expect(envio.template).toEqual({
      name: "retomada",
      language: "pt_BR",
      values: { "1": "Ana" },
    });
  });

  it("o gate messaging_window DEIXA passar — é a flag fazendo efeito, não só existindo", async () => {
    // O guard de forma prova que `isTemplate: true` está escrito. Este caso prova que
    // ele funciona: o inbound tem 30 horas, a janela está fechada, e o envio sai.
    // Se a flag deixasse de ser passada, o gate vetaria e `enviados` ficaria vazio.
    const erro = await rodaTurno(
      montaHandler(
        modeloQueChamaTemplate({ template_name: "retomada", language: "pt_BR", values: { "1": "Bia" } }),
      ),
      ALVO_META,
    );
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toBe("Oi Bia, tudo certo?");
  });

  it("template PENDING é recusado, NADA sai, e o modelo lê o motivo", async () => {
    // O defeito consertado nesta frente: o caminho do agente não checava o status, e
    // um template em análise ia à Graph API para voltar erro genérico.
    const erro = await rodaTurno(
      montaHandler(
        modeloQueChamaTemplate({ template_name: "em_analise", language: "pt_BR", values: { "1": "Ana" } }),
      ),
      ALVO_META,
    );
    expect(erro).toBeNull();

    // O que mais importa: zero envio. Recusa que ainda envia não é recusa.
    expect(enviados).toHaveLength(0);

    // E o modelo RECEBEU o motivo — sem esta asserção, "recusou" não distingue
    // "ensinou o modelo" de "engoliu em silêncio", e o turno terminaria igual.
    expect(JSON.stringify(ultimoResultadoDeTool)).toMatch(/template_nao_aprovado/);
    expect(JSON.stringify(ultimoResultadoDeTool)).toMatch(/PENDING/);
  });

  it("template inexistente também não envia, e diz que é para um humano configurar", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloQueChamaTemplate({ template_name: "nao_existe", language: "pt_BR", values: {} }),
      ),
      ALVO_META,
    );
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(0);
    expect(JSON.stringify(ultimoResultadoDeTool)).toMatch(/template_desconhecido/);
  });
});

describe("turno completo — canal WAHA não ganha a ferramenta", () => {
  it("o modelo TENTA usar a ferramenta e ela não está lá — nenhum template é montado", async () => {
    // O contraste que fecha o seam: mesma org, mesmo contato, mesma janela fechada —
    // só o provider muda.
    //
    // O modelo aqui TENTA chamar `send_template` de propósito. A primeira versão deste
    // caso usava um modelo que só falava texto — e passaria idêntica se a tool
    // estivesse presente, porque ninguém a chamaria. Teste que não distingue os dois
    // mundos não prova nada sobre o gate.
    const erro = await rodaTurno(
      montaHandler(
        modeloQueChamaTemplate({ template_name: "retomada", language: "pt_BR", values: { "1": "Ana" } }),
      ),
      ALVO_WAHA,
    );
    // O turno pode fechar ou falhar — o que NÃO pode é sair template por um canal que
    // não os usa. O `erro` não é asserido: prender o desfecho a uma forma de falha do
    // SDK seria testar o SDK.
    void erro;
    expect(enviados.every((e) => e.template === undefined)).toBe(true);
  });
});
