/**
 * #3813 — O PULO DECIDIDO PELA AGENDA VIRA `skipped` COM MOTIVO NO WORKER `pg`.
 *
 * ## O que faltava na `main`
 *
 * A leitura da escolha (`quando_ha_compromisso`) já existia — `lib/agenda/
 * escolha-no-envio.ts` —, mas só valia no caminho INLINE (`enviar-texto-fixo.ts`)
 * e nas ações de automação. O worker 24/7 do follow-up (`followup_turn`) seguia
 * no padrão `adiar`: nenhum fluxo publicado em `enviar` enviava, e um fluxo em
 * `nao_enviar` não pulava — adiava. Pior: quando o pulo acontecia lá na frente,
 * na guarda do envio, o `AgendaPuladoError` subia como FALHA do run, e o
 * dead-man lia worker morto onde houve decisão de produto.
 *
 * ## O que este arquivo prende
 *
 * 1. `nao_enviar` + compromisso vivo: o turno NÃO chama o modelo, NÃO passa pela
 *    cadeia de guardrails, NÃO envia — e conclui o passo como
 *    `{ kind: 'skipped', reason: 'compromisso_na_agenda' }`;
 * 2. `enviar`: a agenda não segura o passo (o turno segue);
 * 3. sem a chave (padrão `adiar`): comportamento de hoje, byte a byte — e sem
 *    nem uma consulta de agenda a mais;
 * 4. o TICK (`lib/followup/engine.ts`): com `nao_enviar` o motor não reagenda
 *    nem cancela o acompanhamento — ele segue, e quem registra o pulo é o envio.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { createFollowupTurnHandler } from "@/lib/agent-engine/agent/followup-turn";
import type { AdminClient, TickDeps } from "@/lib/followup/engine";

const ORG = "org-1";
const CONTATO = "contact-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const INSCRICAO = "11111111-1111-4111-8111-111111111111";
const NO = "passo";
const COMPROMISSO = "compromisso-1";

const rodada = vi.hoisted(() => ({
  runBeforeSend: vi.fn(async () => ({ status: "sent", outcome: { kind: "sent" } })),
  runAgentTurn: vi.fn(async () => undefined),
}));

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: rodada.runBeforeSend }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
vi.mock("@/lib/agent-engine/agent/inbound-turn", () => ({
  // Sem `importOriginal`: o módulo real arrasta a borda de banco externo
  // (`mysql2`), ausente NESTA VPS. O que este teste mede é o desfecho do pulo,
  // não o turno do modelo.
  runAgentTurn: rodada.runAgentTurn,
  JobSettledError: class JobSettledError extends Error {},
  ritualBlocks: vi.fn(),
}));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  resultadoDoEnvioDoFollowup: vi.fn(async () => ({ kind: "sent" })),
  applySendOutcome: vi.fn(async () => undefined),
}));

/** Canal com disparo 9h–18h, sem jitter; org em Recife. */
const KNOBS = {
  throttle_ms: null,
  jitter_max_ms: 0,
  window_start_hour: 9,
  window_end_hour: 18,
  resposta_start_hour: 0,
  resposta_end_hour: 24,
  allow_sunday: true,
  prospeccao_dias: null,
  timezone: null,
  warmup_daily_caps: null,
  number_activated_at: null,
  org_timezone: "America/Recife",
};

const BOUNDARY = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/** Compromisso que a proteção da agenda segura: começa daqui a dois dias. */
const AGORA = new Date("2026-10-20T13:00:00.000Z");
const COMPROMISSO_VIVO = {
  id: COMPROMISSO,
  contact_id: CONTATO,
  revision: 1,
  starts_at: "2026-10-22T13:00:00.000Z",
  ends_at: "2026-10-22T14:00:00.000Z",
  status: "pending",
};

/**
 * Banco do handler. `escolha` é o que a configuração publicada do follow-up diz
 * (`null` = sem a chave, o que a leitura tolerante trata como `adiar`).
 */
function fakePool(escolha: string | null) {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    sqls.push(sql);
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...BOUNDARY, status: "open", demanda_fechada_em: null }] };
    // A configuração publicada (escolha do FLUXO) vem por este join.
    if (/from followup_enrollments/.test(sql) && /left join ai_agents/.test(sql)) {
      return { rows: [{ followup: escolha === null ? {} : { quando_ha_compromisso: escolha } }] };
    }
    if (/from followup_enrollments/.test(sql)) {
      return { rows: [{ current_node_id: NO, status: "active" }] };
    }
    if (/from calendar_appointments/.test(sql)) return { rows: [COMPROMISSO_VIVO] };
    if (/select settings from organizations/.test(sql)) return { rows: [{ settings: { agenda: null } }] };
    if (/left join channel_knobs/.test(sql)) return { rows: [KNOBS] };
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    return { rows: [] };
  });
  return { pool: { query } as never, sqls };
}

function job(extra: Record<string, unknown> = {}): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: INSCRICAO,
      node_id: NO,
      purpose: "send_message",
      service_boundary: BOUNDARY,
      ...extra,
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

function deps() {
  const send = vi.fn(async (_input: Record<string, unknown>) => ({ kind: "sent" as const, idempotencyKey: "k" }));
  const completeFollowupTurn = vi.fn(async (_pool: unknown, _input: Record<string, unknown>) => undefined);
  const d = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    clock: () => AGORA,
    channel: () => ({ send }),
    completeFollowupTurn,
  } as never;
  return { d, send, completeFollowupTurn };
}

describe("o pulo da agenda no worker do follow-up (#3813)", () => {
  let criarHandler: typeof createFollowupTurnHandler;

  beforeAll(async () => {
    ({ createFollowupTurnHandler: criarHandler } = await import(
      "@/lib/agent-engine/agent/followup-turn"
    ));
  }, 60_000);

  beforeEach(() => {
    rodada.runAgentTurn.mockClear();
    rodada.runBeforeSend.mockClear();
  });

  it("fluxo em `nao_enviar` + compromisso vivo: passo de IA pula com motivo, sem gastar modelo", async () => {
    const { d, send, completeFollowupTurn } = deps();
    const { pool } = fakePool("nao_enviar");

    await criarHandler(d)(job({ prompt_hint: "Retome a conversa." }), pool, { workerId: "w1" });

    expect(rodada.runAgentTurn, "a IA foi chamada para um passo que o fluxo mandou pular").not.toHaveBeenCalled();
    expect(send, "a mensagem saiu para um contato com horário marcado").not.toHaveBeenCalled();
    expect(completeFollowupTurn).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn.mock.calls[0]![1]).toMatchObject({
      nodeId: NO,
      result: { kind: "skipped", reason: "compromisso_na_agenda" },
    });
  });

  it("fluxo em `nao_enviar` + compromisso vivo: texto fixo pula com motivo, sem tocar a cadeia de envio", async () => {
    const { d, send, completeFollowupTurn } = deps();
    const { pool } = fakePool("nao_enviar");

    await criarHandler(d)(job({ fixed_body: "Oi! Passando para retomar." }), pool, { workerId: "w1" });

    expect(rodada.runBeforeSend, "a cadeia de guardrails rodou para um envio que não sai").not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(completeFollowupTurn.mock.calls[0]![1]).toMatchObject({
      result: { kind: "skipped", reason: "compromisso_na_agenda" },
    });
  });

  it("fluxo em `enviar`: a agenda não segura o passo", async () => {
    const { d, completeFollowupTurn } = deps();
    const { pool } = fakePool("enviar");

    await criarHandler(d)(job({ prompt_hint: "Retome a conversa." }), pool, { workerId: "w1" });

    expect(rodada.runAgentTurn, "`enviar` foi tratado como pulo").toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn.mock.calls[0]![1]).toMatchObject({ result: { kind: "sent" } });
  });

  it("sem a chave (padrão `adiar`): comportamento de hoje, e sem consulta de agenda a mais", async () => {
    const { d } = deps();
    const { pool, sqls } = fakePool(null);

    await criarHandler(d)(job({ prompt_hint: "Retome a conversa." }), pool, { workerId: "w1" });

    expect(rodada.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(
      sqls.some((s) => /from calendar_appointments/.test(s)),
      "o caminho padrão passou a pagar uma leitura de agenda que não muda nada",
    ).toBe(false);
  });
});

/* ─── O TICK: `nao_enviar` não reagenda nem cancela o acompanhamento ───────── */

const NO_ESPERA = {
  id: NO,
  type: "wait",
  label: "48 h",
  position: { x: 0, y: 0 },
  config: { mode: "fixed", duration_ms: 172_800_000 },
} as never;

const NO_FIM = {
  id: "fim",
  type: "end",
  label: "Fim",
  position: { x: 0, y: 0 },
  config: { outcome: "exhausted" },
} as never;

function inscricao() {
  return {
    id: INSCRICAO,
    organization_id: ORG,
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: CONTATO,
    conversation_id: CONVERSA,
    current_node_id: NO,
    status: "active",
    next_eval_at: AGORA.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 1,
    outcome: null,
    cancel_reason: null,
    started_at: AGORA.toISOString(),
    completed_at: null,
    updated_at: AGORA.toISOString(),
  };
}

function bancoDoTick(erroDaGuarda: unknown) {
  const patches: Array<Record<string, unknown>> = [];
  const eventos: Array<Record<string, unknown>> = [];
  let carregouGrafo = false;
  const db: Record<string, unknown> = {
    loadFlowGraph: async () => {
      carregouGrafo = true;
      return { nodes: [NO_ESPERA, NO_FIM], edges: [] };
    },
    loadLeadFacts: async () => ({ lead_stage: null, tags: [], contact_name: null, custom_fields: {} }),
    loadEnrollmentEvents: async () => eventos,
    loadLastInboundBody: async () => null,
    loadFlowPointerName: async () => null,
    loadRenderContext: async () => null,
    insertEnrollmentEvent: async (e: Record<string, unknown>) => {
      eventos.push(e);
      return { inserted: true };
    },
    updateEnrollment: async (_i: string, _o: string, p: Record<string, unknown>) => void patches.push(p),
    applyEnrollmentStep: async (_i: string, _o: string, p: Record<string, unknown>) => void patches.push(p),
    assertServiceBoundary: async () => {},
    assertAgenda: async () => {
      if (erroDaGuarda) throw erroDaGuarda;
    },
    retornoQueSeguraOFluxo: async () => null,
  };
  const deps = { db: db as unknown as AdminClient, clock: () => AGORA, enqueueJob: vi.fn(async () => {}) } as TickDeps;
  return { deps, patches, grafoCarregado: () => carregouGrafo };
}

describe("o tick diante do pulo pela agenda (#3813)", () => {
  it("`nao_enviar` (AgendaPuladoError): segue o passo — não cancela, não reagenda", async () => {
    const { AgendaPuladoError } = await import("@/lib/agenda/escolha-no-envio");
    const erro = new AgendaPuladoError({
      adiar: true,
      motivo: "agendado",
      appointment_id: COMPROMISSO,
      reavaliar_em: null,
    });
    const { deps, patches, grafoCarregado } = bancoDoTick(erro);
    const { avancarEnrollmentAtivo } = await import("@/lib/followup/engine");

    await avancarEnrollmentAtivo(deps, inscricao() as never);

    expect(grafoCarregado(), "o motor parou no pulo em vez de seguir o passo").toBe(true);
    expect(
      patches.some((p) => p.status === "cancelled"),
      "o pulo pela agenda cancelou o acompanhamento",
    ).toBe(false);
    expect(
      patches.some((p) => "next_eval_at" in p && p.last_error !== undefined),
      "o pulo pela agenda reagendou como se fosse adiamento",
    ).toBe(false);
  });

  it("`adiar` (AgendaDeferredError): continua reagendando como sempre", async () => {
    const { AgendaDeferredError } = await import("@/lib/agenda/protecao-followup");
    const erro = new AgendaDeferredError({
      adiar: true,
      motivo: "agendado",
      appointment_id: COMPROMISSO,
      reavaliar_em: "2026-10-22T13:00:00.000Z",
    });
    const { deps, patches, grafoCarregado } = bancoDoTick(erro);
    const { avancarEnrollmentAtivo } = await import("@/lib/followup/engine");

    await avancarEnrollmentAtivo(deps, inscricao() as never);

    expect(grafoCarregado()).toBe(false);
    expect(patches).toEqual([
      { next_eval_at: "2026-10-22T13:00:00.000Z", claimed_until: null, last_error: "agenda:agendado" },
    ]);
  });
});
