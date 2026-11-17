/**
 * A ESCOLHA DA REDAÇÃO ACONTECE ONDE A JANELA ESTÁ FRESCA — E A COLISÃO ADIA
 * (#4429, a SEGUNDA porta da issue).
 *
 * ─── As duas portas do #4429 ───────────────────────────────────────────────
 *
 * A primeira (merge #4446) deu ao passo `action`/`text` mais de uma redação e
 * uma rotação determinística. O que sobrou está escrito no próprio módulo da
 * rotação: a escolha é CEGA à janela de `outbound_copies`, e o veto do gate
 * `spinning` cai, em `followup-turn.ts`, como `skipped` — "não re-agendado".
 *
 * `skipped` aqui não é "pule este passo": a ponte (`lib/followup/turn-bridge.ts`)
 * grava `turn_skipped` e CANCELA a inscrição. O lead não recebe a mensagem e o
 * fluxo inteiro morre — com o motivo escrito, mas morto.
 *
 * ─── A decisão de contrato desta fatia, e o caso vizinho que a sustenta ────
 *
 * Quando a redação colide com a janela, o passo é ADIADO — não pulado. É o que
 * o repo já faz na recusa vizinha, `outside_window`: `rescheduleReentry` para o
 * instante da abertura, `complete({kind:'deferred'})` e o enrollment estaciona
 * devendo o envio (ver `janela-fechada-nao-mata-o-enrollment.test.ts`).
 *
 * O risco de trocar `skipped` por `deferred` é o passo que nunca fecha. Por isso
 * o adiamento é LIMITADO: três tentativas por passo. Depois delas o passo
 * encerra com o motivo, como hoje — nenhuma inscrição fica viva para sempre
 * perseguindo uma janela que só anda com outros envios.
 *
 * ─── O que este arquivo NÃO prova ──────────────────────────────────────────
 *
 * Nada com Postgres real (a janela e os knobs são dublados: é o store que os lê
 * no produto), e nada sobre a fila entregar o job re-agendado — isso é do cron,
 * não do turno. O que se mede é: QUAL texto chega à cadeia de envio, e qual
 * desfecho volta para o enrollment.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { SpinningKnobs } from "@/lib/agent-engine/spinning/defaults";

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const ENROLLMENT = "11111111-1111-4111-8111-111111111111";

/** Quinta, 12/11/2026, 13:00Z — o relógio do turno. */
const AGORA = new Date("2026-11-12T13:00:00.000Z");

const A = "Oi Ana, separamos uma condição especial para você e para a sua equipe.";
const B = "Ana, o time liberou uma condição especial e eu queria te contar hoje.";
const C = "Passando para falar da condição que abrimos: ela vale até sexta, Ana.";

const KNOBS: SpinningKnobs = {
  windowSize: 20,
  similarityThreshold: 0.8,
  repetitionThreshold: 2,
  allowlistMaxLength: 12,
  allowlistPatterns: [],
};

const { janelaDeCopias } = vi.hoisted(() => ({
  janelaDeCopias: { textos: [] as string[] },
}));

function janelaAtual() {
  return janelaDeCopias.textos.map((texto) => {
    const normalizedText = texto.toLowerCase().replace(/\s+/g, " ").trim();
    return { normalizedText, normalizedHash: `hash:${normalizedText}` };
  });
}

vi.mock("@/lib/agent-engine/spinning/store", () => ({
  loadSpinningKnobs: vi.fn(async () => KNOBS),
  loadRecentCopies: vi.fn(async () => janelaAtual()),
  recordCopy: vi.fn(async () => undefined),
}));

const JANELA_ABERTA = { status: "sent", outcome: { kind: "sent" }, trace: [] };
const chain = vi.fn(async (_args: Record<string, unknown>) => JANELA_ABERTA as unknown as Record<string, unknown>);
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

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: { ...payload, service_boundary: boundary },
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

/** Quantos adiamentos por repetição este passo já teve (o teto do adiamento). */
let adiamentosAnteriores = 0;

function fakePool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return { rows: [{ current_node_id: "a1", status: "active" }], rowCount: 1 };
    }
    // O teto do adiamento: quantas vezes ESTE passo já foi adiado por repetição.
    if (sql.includes("followup_enrollment_events") && /action_deferred/.test(sql)) {
      return { rows: [{ n: adiamentosAnteriores }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

const PAYLOAD = {
  followup_enrollment_id: ENROLLMENT,
  node_id: "a1",
  purpose: "send_message",
  fixed_body: A,
  fixed_variacoes: [A, B, C],
};

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => {
  chain.mockReset();
  chain.mockImplementation(async () => JANELA_ABERTA as unknown as Record<string, unknown>);
  scheduleCronJob.mockClear();
  janelaDeCopias.textos = [];
  adiamentosAnteriores = 0;
});

function depsComCallback() {
  const completeFollowupTurn = vi.fn(async () => undefined);
  const deps = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // O relógio do turno: sem ele o adiamento sai do `new Date()` real e o
    // `until` deixa de ser comparável ao instante do caso.
    clock: () => new Date(AGORA),
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
    completeFollowupTurn,
  } as never;
  return { deps, completeFollowupTurn };
}

function corpoQueChegouNaCadeia(): string {
  expect(chain).toHaveBeenCalledTimes(1);
  return (chain.mock.calls[0]?.[0] as { body: string }).body;
}

function desfecho(completeFollowupTurn: ReturnType<typeof vi.fn>) {
  expect(completeFollowupTurn).toHaveBeenCalledTimes(1);
  return (completeFollowupTurn.mock.calls[0] as unknown[])[1] as {
    result: { kind: string; until?: Date; reason?: string };
  };
}

describe("#4429 — a redação escolhida olha a janela de repetição", () => {
  it("⭐ janela limpa: sai a preferida da rotação, byte a byte o de hoje", async () => {
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job(PAYLOAD), fakePool(), { workerId: "w1" });

    expect(corpoQueChegouNaCadeia()).toBe(A);
    expect(desfecho(completeFollowupTurn).result.kind).toBe("sent");
  });

  it("⭐ a preferida está vetada pela janela: sai a redação que NÃO colide", async () => {
    // A já foi ao número duas vezes; o gate veta a terceira. B e C nunca foram.
    janelaDeCopias.textos = [A, A];
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job(PAYLOAD), fakePool(), { workerId: "w1" });

    const corpo = corpoQueChegouNaCadeia();
    expect(corpo).not.toBe(A);
    expect([B, C]).toContain(corpo);
    expect(desfecho(completeFollowupTurn).result.kind).toBe("sent");
  });

  it("⭐ TODAS as redações colidem: o passo é ADIADO, e não pulado", async () => {
    janelaDeCopias.textos = [A, A, B, B, C, C];
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job(PAYLOAD), fakePool(), { workerId: "w1" });

    // Nem chega à cadeia: a escolha já sabe que nenhuma passa.
    expect(chain).not.toHaveBeenCalled();
    const entrada = desfecho(completeFollowupTurn);
    expect(entrada.result.kind).toBe("deferred");
    expect(entrada.result.reason).toBe("mass_identical");
    expect(entrada.result.until?.toISOString()).toBe(new Date(AGORA.getTime() + 3_600_000).toISOString());
    // E o job re-agendado existe: sem ele o enrollment acorda para um turno que
    // o cron não vai entregar.
    expect(scheduleCronJob).toHaveBeenCalledTimes(1);
  });

  it("⭐ o veto da CADEIA por repetição (corrida entre a escolha e o envio) também adia", async () => {
    // Passo de redação única: não há o que escolher, e é a cadeia que veta.
    chain.mockImplementation(async () => ({
      status: "vetoed",
      code: "mass_identical",
      trace: [],
    }) as unknown as Record<string, unknown>);
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job({ ...PAYLOAD, fixed_variacoes: undefined }), fakePool(), { workerId: "w1" });

    const entrada = desfecho(completeFollowupTurn);
    expect(entrada.result.kind).toBe("deferred");
    expect(entrada.result.reason).toBe("mass_identical");
    expect(scheduleCronJob).toHaveBeenCalledTimes(1);
  });

  it("depois de três adiamentos por repetição o passo ENCERRA, como hoje", async () => {
    adiamentosAnteriores = 3;
    // A janela tem as três: é o único estado em que o teto é consultado.
    janelaDeCopias.textos = [A, A, B, B, C, C];
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job(PAYLOAD), fakePool(), { workerId: "w1" });

    expect(desfecho(completeFollowupTurn).result.kind).toBe("skipped");
  });

  it("controle positivo: a janela fechada continua adiando como antes (#3103)", async () => {
    chain.mockImplementation(async () => ({
      status: "vetoed",
      code: "outside_window",
      nextAllowedAt: new Date(AGORA.getTime() + 6 * 3_600_000),
      trace: [],
    }) as unknown as Record<string, unknown>);
    const { deps, completeFollowupTurn } = depsComCallback();

    await criarHandler(deps)(job(PAYLOAD), fakePool(), { workerId: "w1" });

    const entrada = desfecho(completeFollowupTurn);
    expect(entrada.result.kind).toBe("deferred");
    expect(entrada.result.reason).toBe("outside_window");
  });
});
