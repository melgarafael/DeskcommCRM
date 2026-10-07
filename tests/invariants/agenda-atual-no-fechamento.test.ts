import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInboundTurnHandler, latestCheckpoint } from "@/lib/agent-engine/agent/inbound-turn";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { claimJobs, completeJob, enqueueJob } from "@/lib/agent-engine/queue/queue";

// Banco descartável do baseline; nenhuma conexão ao banco da instalação.
if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 2,
});
const org = randomUUID(),
  contact = randomUUID(),
  session = randomUUID(),
  conv = randomUUID();
const appointment = randomUUID();
const agora = new Date("2030-07-01T15:00:00Z");
const uso = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,timezone)
    values($1::uuid,$1::text,'Teste Agenda','Teste Agenda','America/Sao_Paulo')`,
    [org],
  );
  await pool.query(
    `insert into contacts(id,organization_id,name,phone_number)
    values($1,$2,'Cliente Fictícia','+5511900000100')`,
    [contact, org],
  );
  await pool.query(
    `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
    values($1,$2,'waha','agenda-test','WORKING','\\x00'::bytea)`,
    [session, org],
  );
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group)
    values($1,$2,$3,$4,'open',false)`,
    [conv, org, contact, session],
  );
  await pool.query(
    `insert into calendar_appointments(id,organization_id,contact_id,title,starts_at,ends_at,time_zone,status)
    values($1,$2,$3,'Consulta','2030-07-03T20:30:00Z','2030-07-03T21:00:00Z','America/Sao_Paulo','confirmed')`,
    [appointment, org, contact],
  );
  await pool.query(`with v as (
    insert into playbook_versions(organization_id,layer,content)
    select null,'platform','Assistente de teste.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id)
    insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`);
});
afterAll(() => pool.end());

describe("o fechamento do motor recebe a reserva atual e a persiste", () => {
  it("17h30 da abertura não prevalece sobre a alteração para 17h concluída durante o turno", async () => {
    let chamadas = 0;
    const prompts: string[] = [];
    const enviados: string[] = [];
    const handler = createInboundTurnHandler({
      crmCfg: { supabase: {} as never },
      llmCfg: { anthropicApiKey: "fake" },
      knobs: {
        historyLimit: 10,
        maxContextTokens: 2000,
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
      log: createLogger(),
      clock: () => agora,
      sleep: async () => {},
      channel: () =>
        ({
          channel: "captura",
          send: async (i: { body: string }) => {
            enviados.push(i.body);
            return { kind: "sent", idempotencyKey: "test", messageId: "fake" };
          },
          sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
          capabilities: () => ({ freeform: true, media: false, audio: false }),
          costPerMessage: () => ({ currency: "BRL", cents: 0 }),
        }) as never,
      registry: createFakeRegistry(async (opts) => {
        chamadas++;
        const texto = JSON.stringify(opts.prompt);
        prompts.push(texto);
        if (chamadas === 1) {
          // A alteração é real no Postgres. A borda de geração somente controla
          // QUANDO ela acontece: depois da abertura, antes do fechamento.
          await pool.query(
            `update calendar_appointments set starts_at='2030-07-03T20:00:00Z',ends_at='2030-07-03T20:30:00Z' where id=$1 and organization_id=$2`,
            [appointment, org],
          );
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "send-1",
                toolName: "send_message",
                input: JSON.stringify({ body: "Pronto, ficou para quarta às 17h." }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: uso,
            warnings: [],
          };
        }
        // O dublê reage ao CONTEXTO recebido pelo caminho real. Não prova a
        // semântica de um modelo real; prova a leitura, o wiring e a gravação.
        const temAtual =
          texto.includes("Agenda verificada depois das ações deste turno") &&
          texto.includes("2030-07-03T17:00:00-03:00");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                commitments: [temAtual ? "Consulta reservada às 17h." : "Consulta ainda às 17h30."],
                objections: ["Prefere o fim da tarde."],
                next_action: "Aguardar comparecimento.",
                rolling_summary: temAtual
                  ? "Remarcação concluída para 17h."
                  : "Remarcação ainda não realizada.",
              }),
            },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage: uso,
          warnings: [],
        };
      }),
    });
    const msg = randomUUID();
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at)
      values($1,$2,$3,$4,$5,'text','inbound','delivered','Pode mudar para 17h?','external_device',$6)`,
      [msg, org, conv, session, contact, agora],
    );
    await pool.query(`update job_queue set status='done' where status='pending'`);
    const { job } = await enqueueJob(pool, org, {
      kind: "inbound_turn",
      leadId: contact,
      payload: {
        conversation_id: conv,
        contact_id: contact,
        channel_session_id: session,
        inbound_message_id: msg,
        crm_event_id: randomUUID(),
      },
      maxAttempts: 1,
    });
    const [claimed] = await claimJobs(pool, { workerId: "agenda-test", maxConcurrency: 1 });
    expect(claimed?.id).toBe(job.id);
    await handler(claimed!, pool, { workerId: "agenda-test" });
    await completeJob(pool, claimed!.id, "agenda-test");
    expect(enviados).toHaveLength(1);
    expect(prompts[0]).toContain("17:30");
    expect(prompts.at(-1)).toContain("Agenda verificada depois das ações deste turno");
    // A etapa final do modelo não tinha ferramentas. No SDK atual somente
    // responseMessages conserva o envio executado na etapa anterior.
    expect(prompts.at(-1)).toContain("[ferramenta send_message chamada com");
    // O fechamento vai sem `tools`: nenhuma parte de ferramenta pode chegar ao
    // provedor (a Anthropic recusa tool_use/tool_result sem tools definidas).
    const fechamento = JSON.parse(prompts.at(-1)!) as Array<{ role: string; content: unknown }>;
    expect(fechamento.filter((m) => m.role === "tool")).toEqual([]);
    expect(prompts.at(-1)).not.toMatch(/"type":"tool-(call|result)"/);
    const checkpoint = await latestCheckpoint(pool, org, contact);
    expect(checkpoint?.commitments).toEqual(["Consulta reservada às 17h."]);
    expect(checkpoint?.rolling_summary).toBe("Remarcação concluída para 17h.");
    expect(checkpoint?.objections).toEqual(["Prefere o fim da tarde."]);
  });
});
