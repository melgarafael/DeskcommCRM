/**
 * O TURNO DE ENVIO QUE JÁ ESTAVA RODANDO NO INSTANTE DA SUSPENSÃO.
 *
 * A suspensão (`fn_org_parada_descarta_fila`, migration 0501) falha o turno
 * `pending` e grava `turn_discarded`, que faz o motor enfileirar um turno novo
 * na reativação. O turno `running` ela não toca: ele segue, o envio é barrado
 * com `OrgNaoOperanteError` e o worker o cancela (`terminal`). Sem o mesmo
 * evento, a reativação lia esse cancelamento como worker morto, os rechecks
 * esgotavam o dead-man e a inscrição morria com `action_turn_never_completed`
 * — um motivo falso, na Central.
 *
 * Aqui mede-se o lado do worker: ele grava o evento pela função do servidor
 * (`fn_followup_turno_descartado`) e devolve o erro para a fila cancelar o job.
 * O efeito no banco (evento gravado, turno novo na reativação) é do
 * `test:db`: tests/invariants/followup-org-suspensa.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFollowupTurnHandler as criarHandler } from "@/lib/agent-engine/agent/followup-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const AGORA = new Date("2026-09-30T12:00:00.000Z");

const chain = vi.fn(async (_args: Record<string, unknown>): Promise<Record<string, unknown>> => ({}));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: (args: Record<string, unknown>) => chain(args),
}));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));

const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function job(purpose: string): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
      node_id: "a1",
      purpose,
      fixed_body: "oi, tudo bem?",
      service_boundary: boundary,
    },
    status: "running",
    priority: 0,
    run_after: AGORA,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: AGORA,
    created_at: AGORA,
  } as JobRow;
}

function fakePool() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: "canal-1", archived_at: null }] };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, query };
}

const descartes = (query: ReturnType<typeof fakePool>["query"]) =>
  query.mock.calls.filter(([sql]) => sql.includes("fn_followup_turno_descartado"));

function deps() {
  const completeFollowupTurn = vi.fn(async () => undefined);
  return {
    deps: {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      crmCfg: {},
      llmCfg: {},
      knobs: {},
      channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
      completeFollowupTurn,
    } as never,
    completeFollowupTurn,
  };
}

beforeEach(() => {
  chain.mockReset();
});

describe("turno de envio barrado pela suspensão no meio do caminho", () => {
  it("⭐ grava turn_discarded pela função do servidor e devolve o erro para a fila cancelar", async () => {
    chain.mockRejectedValue(new OrgNaoOperanteError(ORG, "suspended"));
    const { pool, query } = fakePool();
    const { deps: d, completeFollowupTurn } = deps();

    const erro = await criarHandler(d)(job("send_message"), pool, { workerId: "w1" }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro, "o erro precisa chegar à fila, que cancela o job (terminal)").toBeInstanceOf(OrgNaoOperanteError);
    expect(descartes(query), "sem o evento a reativação mata a inscrição").toHaveLength(1);
    expect(descartes(query)[0]![1]).toEqual([ORG, "job-1"]);
    expect(completeFollowupTurn).not.toHaveBeenCalled();
  });

  it("controle: falha que não é suspensão NÃO grava o descarte (o dead-man segue valendo)", async () => {
    chain.mockRejectedValue(new Error("canal fora"));
    const { pool, query } = fakePool();

    await expect(criarHandler(deps().deps)(job("send_message"), pool, { workerId: "w1" })).rejects.toThrow("canal fora");
    expect(descartes(query)).toHaveLength(0);
  });
});
