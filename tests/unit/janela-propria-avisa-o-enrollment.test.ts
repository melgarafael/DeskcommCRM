/**
 * A FAIXA PRÓPRIA DO FOLLOW-UP TAMBÉM AVISA O ENROLLMENT QUE ADIOU.
 *
 * O portão da faixa por agente (#1134) roda no topo do handler, ANTES de
 * `runFlowDrivenTurn`: fora da faixa ele re-agenda o job e retorna. O conserto
 * do dead-man (#1171) só enxerga a espera quando o turno devolve
 * `{kind:'deferred'}` ao enrollment — é esse evento que conta como prova de
 * vida. Um portão que re-agenda calado deixa o motor rechecando um turno que
 * ninguém fecha, e com o padrão de fábrica da faixa (sexta 18h → segunda 9h,
 * 63h) o enrollment morre em ~11h com `action_turn_never_completed`.
 *
 * Este arquivo prende o elo que liga as duas peças. Não prova nada com
 * Postgres real nem pela tela.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";

/** Sexta 18:00 em São Paulo — a faixa 09:00-18:00 seg-sex acabou de fechar. */
const SEXTA_18H = new Date("2026-09-18T21:00:00.000Z");
const SEGUNDA_09H = new Date("2026-09-21T12:00:00.000Z");
/** Quinta 14:00 em São Paulo — dentro da faixa. */
const QUINTA_14H = new Date("2026-09-17T17:00:00.000Z");

const FOLLOWUP_COM_FAIXA = {
  enabled: true,
  flow_pointer_ids: [],
  send_window: { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] },
};

const chain = vi.fn(async (_args: Record<string, unknown>) => ({
  status: "sent",
  outcome: { kind: "sent" },
  trace: [],
}) as unknown as Record<string, unknown>);
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

const scheduleCronJob = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ scheduleCronJob }));

const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function job(): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
      node_id: "a1",
      purpose: "send_message",
      fixed_body: "oi, tudo bem?",
      service_boundary: boundary,
    },
    status: "running",
    priority: 0,
    run_after: SEXTA_18H,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: SEXTA_18H,
    created_at: SEXTA_18H,
  } as JobRow;
}

function fakePool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    if (sql.includes("a.published_version_id")) return { rows: [{ followup: FOLLOWUP_COM_FAIXA }], rowCount: 1 };
    // A inscrição viva que o handler consulta ANTES do envio (guard da #1913).
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return { rows: [{ current_node_id: "a1", status: "active" }], rowCount: 1 };
    }
    if (sql.includes("select timezone from organizations")) return { rows: [{ timezone: "America/Sao_Paulo" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

function deps(agora: Date) {
  const completeFollowupTurn = vi.fn(async () => undefined);
  const d = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    clock: () => agora,
    channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
    completeFollowupTurn,
  } as never;
  return { d, completeFollowupTurn };
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => {
  chain.mockClear();
  scheduleCronJob.mockClear();
});

describe("a faixa própria do follow-up devolve o adiamento ao enrollment", () => {
  it("⭐ fora da faixa: re-agenda para a abertura E avisa o enrollment com o mesmo instante", async () => {
    const { d, completeFollowupTurn } = deps(SEXTA_18H);

    await criarHandler(d)(job(), fakePool(), { workerId: "w1" });

    expect(chain, "fora da faixa o envio não pode nem chegar à cadeia").not.toHaveBeenCalled();
    expect(scheduleCronJob).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn, "o adiamento da faixa não voltou para o enrollment").toHaveBeenCalledTimes(1);
    const entrada = (completeFollowupTurn.mock.calls[0] as unknown[])[1] as {
      nodeId: string;
      result: { kind: string; until?: Date };
    };
    expect(entrada.nodeId).toBe("a1");
    expect(entrada.result.kind).toBe("deferred");
    expect(entrada.result.until?.toISOString()).toBe(SEGUNDA_09H.toISOString());
  });

  it("controle positivo: dentro da faixa o turno segue e reporta 'sent'", async () => {
    const { d, completeFollowupTurn } = deps(QUINTA_14H);

    await criarHandler(d)(job(), fakePool(), { workerId: "w1" });

    expect(scheduleCronJob).not.toHaveBeenCalled();
    expect(chain).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn).toHaveBeenCalledTimes(1);
    const entrada = (completeFollowupTurn.mock.calls[0] as unknown[])[1] as { result: { kind: string } };
    expect(entrada.result.kind).toBe("sent");
  });
});
