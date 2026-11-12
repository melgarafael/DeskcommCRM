import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "../queue/queue";
import type { InboundTurnDeps } from "./inbound-turn";
import { createHistoryAnalysisHandler } from "./history-analysis";

const mocks = vi.hoisted(() => ({
  runModelCall: vi.fn(),
  insertCheckpoint: vi.fn(),
  applyLeadStateUpdate: vi.fn(),
  recalculaScoreDoLead: vi.fn(),
}));

vi.mock("../edge/llm/run-model-call", () => ({ runModelCall: mocks.runModelCall }));
vi.mock("./abertura/checkpoint", () => ({ insertCheckpoint: mocks.insertCheckpoint }));
vi.mock("./lead-state", () => ({ applyLeadStateUpdate: mocks.applyLeadStateUpdate }));
vi.mock("@/lib/leads/score-writer", () => ({ recalculaScoreDoLead: mocks.recalculaScoreDoLead }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const IMPORTACAO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const MENSAGEM = "55555555-5555-4555-8555-555555555555";
const NEGOCIO = "66666666-6666-4666-8666-666666666666";

const job: JobRow = {
  id: "77777777-7777-4777-8777-777777777777",
  organization_id: ORG,
  contact_id: CONTATO,
  kind: "history_analysis",
  source_event_id: null,
  payload: { importacao_id: IMPORTACAO, conversation_id: CONVERSA },
  status: "running",
  priority: 140,
  run_after: new Date("2026-11-05T22:00:00Z"),
  attempts: 1,
  max_attempts: 3,
  last_error: null,
  locked_by: "worker-1",
  locked_at: new Date("2026-11-05T22:00:00Z"),
  created_at: new Date("2026-11-05T22:00:00Z"),
};

function dependencias(): InboundTurnDeps {
  return {
    llmCfg: {} as InboundTurnDeps["llmCfg"],
    crmCfg: {} as InboundTurnDeps["crmCfg"],
    knobs: {} as InboundTurnDeps["knobs"],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as InboundTurnDeps;
}

/**
 * `motivoAntes` é o que a régua do banco (`fn_historico_analise_motivo_para_pular`)
 * responde antes de ler a conversa; `motivoNaEscrita`, o que ela responde dentro
 * da transação que grava, depois da chamada de IA.
 */
function banco(
  recibo = false,
  { motivoAntes = null, motivoNaEscrita = null }: { motivoAntes?: string | null; motivoNaEscrita?: string | null } = {},
) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("fn_historico_analise_motivo_para_pular")) return { rows: [{ motivo: motivoNaEscrita }] };
      if (sql.includes("from crm_leads")) {
        return {
          rows: [{
            id: NEGOCIO,
            organization_id: ORG,
            pipeline_id: "88888888-8888-4888-8888-888888888888",
            status: "open",
            last_activity_at: null,
            created_at: "2026-11-01T00:00:00Z",
          }],
        };
      }
      throw new Error(`SQL inesperado no client: ${sql}`);
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("from lead_checkpoints")) return { rows: recibo ? [{ id: "recibo" }] : [] };
      if (sql.includes("fn_historico_analise_motivo_para_pular")) return { rows: [{ motivo: motivoAntes }] };
      if (sql.includes("from messages")) {
        return {
          rows: [{ id: MENSAGEM, direction: "inbound", sent_at: "2026-11-01T00:00:00Z", body: "Preciso de 500 cadeiras" }],
        };
      }
      throw new Error(`SQL inesperado no pool: ${sql}`);
    }),
    connect: vi.fn(async () => client),
  };
  return { pool, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runModelCall.mockResolvedValue({
    result: {
      text: JSON.stringify({
        commitments: ["Enviar proposta"],
        objections: [],
        next_action: "Preparar proposta de 500 cadeiras",
        rolling_summary: "Cliente pediu 500 cadeiras.",
        qualification: { budget: null, authority: null, need: "500 cadeiras", timeline: null },
        evidence_message_ids: [MENSAGEM],
      }),
    },
  });
  mocks.applyLeadStateUpdate.mockResolvedValue({ ok: true });
});

describe("handler da análise do histórico", () => {
  it("grava checkpoint/BANT/score numa transação, sem depender de canal", async () => {
    const { pool, client } = banco();
    await createHistoryAnalysisHandler(dependencias())(
      job,
      pool as never,
      { workerId: "worker-1" },
    );

    expect(mocks.runModelCall).toHaveBeenCalledWith(
      pool,
      expect.anything(),
      expect.objectContaining({ purpose: "checkpoint", tenantId: ORG, leadId: CONTATO }),
      expect.anything(),
    );
    expect(mocks.insertCheckpoint).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ tenantId: ORG, leadId: CONTATO, jobId: job.id }),
    );
    expect(mocks.applyLeadStateUpdate).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ tenantId: ORG, leadId: CONTATO }),
      { qualification: { need: "500 cadeiras" }, next_action: "Preparar proposta de 500 cadeiras" },
    );
    expect(mocks.recalculaScoreDoLead).toHaveBeenCalledWith(client, ORG, NEGOCIO);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "begin",
      expect.stringContaining("fn_historico_analise_motivo_para_pular"),
      expect.stringContaining("from crm_leads"),
      "commit",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("usa o checkpoint como recibo e não repete uma análise confirmada", async () => {
    const { pool } = banco(true);
    await createHistoryAnalysisHandler(dependencias())(
      job,
      pool as never,
      { workerId: "worker-1" },
    );

    expect(mocks.runModelCall).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("trava 3: contato que recusou IA não tem a conversa lida nem gasta chamada de IA", async () => {
    const { pool } = banco(false, { motivoAntes: "recusou_ia" });
    await createHistoryAnalysisHandler(dependencias())(job, pool as never, { workerId: "worker-1" });

    expect(pool.query.mock.calls.map(([sql]) => sql).some((sql) => sql.includes("from messages"))).toBe(false);
    expect(mocks.runModelCall).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("trava 3: contato com qualificação mais nova que o histórico não é analisado", async () => {
    const { pool } = banco(false, { motivoAntes: "estado_mais_novo" });
    await createHistoryAnalysisHandler(dependencias())(job, pool as never, { workerId: "worker-1" });

    expect(mocks.runModelCall).not.toHaveBeenCalled();
    expect(mocks.applyLeadStateUpdate).not.toHaveBeenCalled();
  });

  it("trava 3: se algo mais novo foi gravado durante a chamada de IA, nada é escrito por cima", async () => {
    const { pool, client } = banco(false, { motivoNaEscrita: "estado_mais_novo" });
    await createHistoryAnalysisHandler(dependencias())(job, pool as never, { workerId: "worker-1" });

    expect(mocks.runModelCall).toHaveBeenCalledOnce();
    expect(mocks.insertCheckpoint).not.toHaveBeenCalled();
    expect(mocks.applyLeadStateUpdate).not.toHaveBeenCalled();
    expect(mocks.recalculaScoreDoLead).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "begin",
      expect.stringContaining("fn_historico_analise_motivo_para_pular"),
      "rollback",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
