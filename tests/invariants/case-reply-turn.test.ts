import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

/**
 * Wave 3b (spec 15 §4.3) — handler `case_reply_turn`, o loop de follow-up de
 * cabeça pra baixo: a RESPOSTA DO HUMANO reinjeta o turno do agente. Real
 * Postgres via TEST_DB_CONTAINER (mesmo mecanismo de human-cases.test.ts /
 * agent-config-cases.test.ts) para a resolução caso→conversa; `runAgentTurn`
 * (inbound-turn.ts) é mockado — não existe seam de harness pra rodar o núcleo
 * do turno (LLM + envio) neste repo (mesma lacuna documentada em
 * agent-config-cases.test.ts para o gating de casesEnabled). O que importa
 * verificar aqui: 1) os ids de envio resolvidos são os da CONVERSA DO CASO
 * (nunca genéricos), 2) o texto de abertura por ação, 3) os no-ops defensivos
 * nunca chamam runAgentTurn nem derrubam o worker.
 */

vi.mock("@/lib/agent-engine/agent/inbound-turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-engine/agent/inbound-turn")>();
  return { ...actual, runAgentTurn: vi.fn() };
});

import { runAgentTurn, type InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import { createCaseReplyTurnHandler } from "@/lib/agent-engine/agent/case-reply-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const CONTACT = "eeeeeeee-0000-4000-8000-000000000002";
const SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const CONV = "eeeeeeee-0000-4000-8000-000000000004";

// resolved — a rota (Wave 5) já commitou a transição ANTES/COM o enqueue deste
// job; por isso o status aqui é o PÓS-transição (resolved), não awaiting_human.
const CASE_RESOLVED_FLOW = "eeeeeeee-1000-4000-8000-000000000001";
// awaiting_lead — idem, pós-transição de need_lead_info
const CASE_NEED_INFO_FLOW = "eeeeeeee-1000-4000-8000-000000000002";
// escalated — mismatch genuíno: um job action=resolved chega mas o caso foi
// escalado por outra via (corrida real) → status ≠ EXPECTED_STATUS_FOR_ACTION
const CASE_STATUS_MISMATCH = "eeeeeeee-1000-4000-8000-000000000003";
// awaiting_human — recebe uma action fora do escopo de re-entrada (ex.: escalate)
const CASE_INVALID_ACTION = "eeeeeeee-1000-4000-8000-000000000004";
const CASE_NONEXISTENT = "eeeeeeee-1000-4000-8000-00000000dead";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'crt-proof', 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Contato de Prova', '+5511900000001') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'crt-proof-session', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'ai_handling', false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );

  const insertCase = async (id: string, status: string) => {
    await pool.query(
      `insert into agent_cases (id, organization_id, conversation_id, title, summary, blocker, status, closed_at)
       values ($1, $2, $3, 'Caso de prova', 'resumo de prova', 'bloqueio de prova', $4,
               case when $4 in ('resolved','escalated','cancelled') then now() else null end)
       on conflict (id) do nothing`,
      [id, ORG, CONV, status],
    );
  };
  await insertCase(CASE_RESOLVED_FLOW, "resolved");
  await insertCase(CASE_NEED_INFO_FLOW, "awaiting_lead");
  await insertCase(CASE_STATUS_MISMATCH, "escalated");
  await insertCase(CASE_INVALID_ACTION, "awaiting_human");
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  vi.mocked(runAgentTurn).mockReset();
  vi.mocked(runAgentTurn).mockResolvedValue(undefined);
});

function fakeJob(caseId: string, action: string, body?: string): JobRow {
  return {
    id: `job-${caseId}`,
    organization_id: ORG,
    contact_id: CONTACT,
    kind: "case_reply_turn",
    source_event_id: null,
    payload: { case_id: caseId, action, ...(body !== undefined ? { body } : {}) },
    status: "running",
    priority: 100,
    run_after: new Date(),
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    locked_by: "test-worker",
    locked_at: new Date(),
    created_at: new Date(),
  };
}

function fakeLogger(): Logger & { entries: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
  const entries: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  return {
    entries,
    info: (msg, fields) => entries.push({ level: "info", msg, ...(fields !== undefined ? { fields } : {}) }),
    warn: (msg, fields) => entries.push({ level: "warn", msg, ...(fields !== undefined ? { fields } : {}) }),
    error: (msg, fields) => entries.push({ level: "error", msg, ...(fields !== undefined ? { fields } : {}) }),
  };
}

function fakeDeps(log: Logger): InboundTurnDeps {
  return {
    crmCfg: { supabase: createClient("http://127.0.0.1", "test-key") },
    llmCfg: {},
    knobs: {
      historyLimit: 20,
      maxContextTokens: 1_000,
      notesIndexMaxTokens: 500,
      maxSteps: 6,
      queuedRetryDelayMs: 1_000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 4,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 6,
        noProgressWarn: 2,
        noProgressBlock: 4,
      },
    },
    log,
  };
}

function fakeLeadContext(): LeadContext {
  return {
    lead_id: CONTACT,
    contact: { name: "Contato de Prova", phone: null, email: null, tags: [], is_blocked: false, custom_fields: {} },
    conversation_id: CONV,
    last_human_decision: null,
    messages: [],
  };
}

describe("case_reply_turn — re-entrada do agente pela resposta do humano", () => {
  it("resolved: resolve a conversa DO CASO e chama runAgentTurn com opening contendo a nota + instrução de repasse", async () => {
    const log = fakeLogger();
    const handler = createCaseReplyTurnHandler(fakeDeps(log));
    const job = fakeJob(CASE_RESOLVED_FLOW, "resolved", "cliente liberado no sistema X");

    await handler(job, pool, { workerId: "test-worker" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runAgentTurn).mock.calls[0]!;
    const input = call[4]!;
    expect(input.conversationId).toBe(CONV);
    expect(input.channelSessionId).toBe(SESSION);

    const opening = input.buildOpening({ previous: null, leadState: null, context: fakeLeadContext(), notesIndexBlock: "—" });
    expect(opening).toContain("cliente liberado no sistema X");
    expect(opening).toContain("Repasse essa conclusão ao lead");
    expect(opening).toContain("send_message");
  });

  it("need_lead_info: opening contém o pedido de info + instrução de chamar provide_case_update com o case_id", async () => {
    const log = fakeLogger();
    const handler = createCaseReplyTurnHandler(fakeDeps(log));
    const job = fakeJob(CASE_NEED_INFO_FLOW, "need_lead_info", "CPF do titular da compra");

    await handler(job, pool, { workerId: "test-worker" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runAgentTurn).mock.calls[0]!;
    const input = call[4]!;
    expect(input.conversationId).toBe(CONV);
    expect(input.channelSessionId).toBe(SESSION);

    const opening = input.buildOpening({ previous: null, leadState: null, context: fakeLeadContext(), notesIndexBlock: "—" });
    expect(opening).toContain("CPF do titular da compra");
    expect(opening).toContain("provide_case_update");
    expect(opening).toContain(CASE_NEED_INFO_FLOW);
  });

  it("status não bate com o esperado pra ação (ex.: resolved chega mas o caso foi escalado por outra via) → no-op: não chama runAgentTurn, não crasha, e loga", async () => {
    const log = fakeLogger();
    const handler = createCaseReplyTurnHandler(fakeDeps(log));
    const job = fakeJob(CASE_STATUS_MISMATCH, "resolved", "resposta tardia — caso escalado por outra via");

    await expect(handler(job, pool, { workerId: "test-worker" })).resolves.toBeUndefined();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(log.entries.some((e) => e.level === "info")).toBe(true);
  });

  it("caso inexistente → no-op: não chama runAgentTurn, não crasha, e loga", async () => {
    const log = fakeLogger();
    const handler = createCaseReplyTurnHandler(fakeDeps(log));
    const job = fakeJob(CASE_NONEXISTENT, "resolved", "nota qualquer");

    await expect(handler(job, pool, { workerId: "test-worker" })).resolves.toBeUndefined();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(log.entries.some((e) => e.level === "info")).toBe(true);
  });

  it("action fora do escopo de re-entrada (ex.: escalate) → no-op mesmo com caso aberto válido", async () => {
    const log = fakeLogger();
    const handler = createCaseReplyTurnHandler(fakeDeps(log));
    const job = fakeJob(CASE_INVALID_ACTION, "escalate", "motivo qualquer");

    await expect(handler(job, pool, { workerId: "test-worker" })).resolves.toBeUndefined();
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(log.entries.some((e) => e.level === "info")).toBe(true);
  });
});
