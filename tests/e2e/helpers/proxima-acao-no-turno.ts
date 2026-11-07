import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";

import { createInboundTurnHandler } from "../../../lib/agent-engine/agent/inbound-turn";
import { createFakeRegistry } from "../../../lib/agent-engine/edge/llm/providers";
import { createLogger } from "../../../lib/agent-engine/obs/logger";
import { completeJob, enqueueJob, type JobRow } from "../../../lib/agent-engine/queue/queue";

/**
 * Mesmo seam dos invariantes de turno: só a resposta do modelo e a entrega do
 * canal são sintéticas. Handler, ferramentas e SQL rodam contra o banco real.
 * Não mede a qualidade de um modelo externo nem entrega num aparelho.
 */
export async function proximaAcaoNoTurno(
  pool: pg.Pool,
  ids: { org: string; contato: string; canal: string; conversa: string },
  nextAction: string | null,
): Promise<void> {
  const mensagem = randomUUID();
  const worker = `proposta-${randomUUID()}`;
  const entrada = { next_action: nextAction };
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now())`,
    [mensagem, ids.org, ids.conversa, ids.canal, ids.contato, JSON.stringify(entrada)],
  );
  const { job } = await enqueueJob(pool, ids.org, {
    kind: "inbound_turn", leadId: ids.contato, maxAttempts: 1,
    payload: {
      conversation_id: ids.conversa, contact_id: ids.contato, channel_session_id: ids.canal,
      inbound_message_id: mensagem, crm_event_id: randomUUID(),
    },
  });
  // Prepara SOMENTE o job desta fixture como já adquirido. Um claim global
  // poderia consumir trabalhos deixados pelas specs vizinhas no mesmo banco.
  const { rows } = await pool.query<JobRow>(
    `update job_queue set status='running', locked_by=$3, locked_at=now(), attempts=attempts+1
     where id=$1 and organization_id=$2 and status='pending'
     returning *, locked_at::text as claim_acquired_at`, [job.id, ids.org, worker],
  );
  if (rows.length !== 1) throw new Error("A fixture não adquiriu seu próprio turno.");
  let geracoes = 0;
  let envios = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const modelo = async () => {
    if (geracoes++ === 0) return {
      content: [
        { type: "tool-call" as const, toolCallId: "acao", toolName: "update_lead_state", input: JSON.stringify(entrada) },
        { type: "tool-call" as const, toolCallId: "resposta", toolName: "send_message", input: JSON.stringify({ body: `Obrigado. Confirmação ${mensagem.slice(0, 8)}.` }) },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [],
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "Turno sintético de próxima ação." }) }],
      finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [],
    };
  };
  const handler = createInboundTurnHandler({
    crmCfg: { supabase: {} as never }, llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10, maxContextTokens: 2000, notesIndexMaxTokens: 500, maxSteps: 8,
      queuedRetryDelayMs: 1000,
      breaker: { exactFailureWarn: 2, exactFailureBlock: 5, sameToolFailureWarn: 3, sameToolFailureHalt: 8, noProgressWarn: 3, noProgressBlock: 5 },
    },
    log: createLogger(), registry: createFakeRegistry(modelo),
    channel: () => ({
      channel: "captura",
      send: async () => ({ kind: "sent" as const, idempotencyKey: `k-${++envios}`, messageId: randomUUID() }),
      sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
      capabilities: () => ({ freeform: true, media: true, audio: true }),
      costPerMessage: () => ({ currency: "BRL", cents: 0 }),
    }) as never,
    clock: () => new Date(), sleep: async () => {},
  });
  await handler(rows[0]!, pool, { workerId: worker });
  await completeJob(pool, job.id, worker);
  if (geracoes < 2 || envios !== 1) throw new Error("O turno não atravessou o modelo e a resposta esperados.");
}

// Entrada exclusiva da prova: Node + tsx instalado, sem loader do Playwright.
// Só o modelo/canal acima são dublês; handler, ferramentas e banco são reais.
const argumento = process.argv.indexOf("--executar-proxima-acao");
if (argumento >= 0) {
  const executar = async () => {
    const url = process.env.E2E_TURNO_DB_URL;
    if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
      throw new Error("A prova do turno exige um Postgres local do harness.");
    }
    const entrada = z
      .object({
        ids: z.object({ org: z.uuid(), contato: z.uuid(), canal: z.uuid(), conversa: z.uuid() }),
        nextAction: z.string().nullable(),
      })
      .parse(JSON.parse(process.argv[argumento + 1] ?? "null"));
    // before_send mantém um client até persistir a auditoria autônoma pelo
    // pool; uma segunda conexão é necessária para esse caminho completar.
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      await proximaAcaoNoTurno(pool, entrada.ids, entrada.nextAction);
    } finally {
      await pool.end();
    }
  };
  void executar().catch((erro: unknown) => {
    process.stderr.write(`${erro instanceof Error ? erro.message : "Falha na prova do turno."}\n`);
    process.exitCode = 1;
  });
}
