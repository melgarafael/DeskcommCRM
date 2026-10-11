/**
 * Produção (PLJR, 09-10/10/2026): 8 inscrições `dormente` do fluxo de follow-up
 * com espera longa foram canceladas no minuto exato do disparo com
 * `cancel_reason = 'Atendimento encerrado ou substituído'` — conversa aberta,
 * mesma revisão, sem demanda. Duas delas cancelaram 59 s e 50 s depois do
 * `next_eval_at`, com a conversa aberta e a mesma revisão.
 *
 * Causa: `processEnrollment` chamava `assertAgenda` também para o `dormente`, e
 * a guarda (`fn_appointment_enrollment_current`) só aceita
 * `active`/`waiting_reply` — todo despertar dormente virava
 * `StaleServiceBoundaryError`, que o `catch` rotula de fronteira vencida.
 * O conserto: o despertar do dormente pula a guarda de agenda (não é efeito);
 * os efeitos a repetem com o status já `active`.
 */
import { describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "../atendimento/fronteira";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "./engine";
import type { FlowGraph } from "./graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "./node-handlers";

const NOW = new Date("2026-10-10T18:01:00.000Z");
const DISPARO = "2026-10-10T18:00:01.959Z";

const GRAFO = {
  nodes: [
    { id: "trigger-1", type: "trigger", config: { kind: "manual" } },
    {
      id: "wait-3",
      type: "wait",
      config: { mode: "fixed", duration_ms: 86_400_000, immune_to_reply: true },
    },
    { id: "action-4", type: "action", config: { mode: "text", body: "retome o contato" } },
    { id: "end-5", type: "end", config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "e1", source: "trigger-1", target: "wait-3", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "wait-3", target: "action-4", priority: 0, condition: { type: "always" } },
    { id: "e3", source: "action-4", target: "end-5", priority: 0, condition: { type: "always" } },
  ],
} as unknown as FlowGraph;

function inscricaoDormente(): EnrollmentRow {
  return {
    id: "enr-dormente-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    current_node_id: "wait-3",
    status: "dormente",
    next_eval_at: DISPARO,
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 3,
    outcome: null,
    cancel_reason: null,
    started_at: "2026-10-09T17:57:03.000Z",
    completed_at: null,
    updated_at: NOW.toISOString(),
  };
}

const EVENTOS: EnrollmentEventRef[] = [
  {
    node_id: "wait-3",
    idempotency_key: "wait-3:2",
    event_type: "wait_started",
    payload: { wake_status: "dormente", next_eval_at: DISPARO },
  },
];

function montarDb(opcoes: { fronteiraVencida: boolean }) {
  const patches: Array<Record<string, unknown>> = [];
  const avisos: Array<Record<string, unknown>> = [];
  const agendaChamada: string[] = [];

  const db = {
    // Imita a regra real do SQL (`fn_appointment_enrollment_current` só aceita
    // `active`/`waiting_reply`): sem esta imitação o teste mediria o mock, não
    // o defeito.
    assertAgenda: vi.fn(async (enrollment: EnrollmentRow) => {
      agendaChamada.push(enrollment.id);
      if (enrollment.status !== "active" && enrollment.status !== "waiting_reply") {
        throw new StaleServiceBoundaryError();
      }
    }),
    assertServiceBoundary: vi.fn(async () => {
      if (opcoes.fronteiraVencida) throw new StaleServiceBoundaryError();
    }),
    loadFlowGraph: vi.fn(async () => GRAFO),
    loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
    loadEnrollmentEvents: vi.fn(async () => EVENTOS),
    loadFlowPointerName: vi.fn(async () => "Fluxo de retorno"),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    updateEnrollment: vi.fn(async (_id: string, _org: string, patch: Record<string, unknown>) => {
      patches.push(patch);
    }),
    insertDeadInboxItem: vi.fn(async (item: Record<string, unknown>) => {
      avisos.push(item);
    }),
  } as unknown as AdminClient;

  return { db, patches, avisos, agendaChamada };
}

describe("dormente no disparo — a guarda de agenda não cancela", () => {
  it("com fronteira válida, avança para o próximo nó sem cancelar e sem aviso", async () => {
    const { db, patches, avisos, agendaChamada } = montarDb({ fronteiraVencida: false });

    const deps: TickDeps = { db, clock: () => NOW, enqueueJob: async () => {} };
    await avancarEnrollmentAtivo(deps, inscricaoDormente());

    // A guarda de agenda do SQL vetaria este status — o motor não pode chamá-la.
    expect(agendaChamada).toEqual([]);
    expect(patches.some((p) => p.status === "cancelled")).toBe(false);
    expect(avisos).toEqual([]);
    expect(patches.some((p) => p.current_node_id === "action-4" && p.status === "active")).toBe(true);
  });

  it("controle: com fronteira realmente vencida, continua cancelando com aviso", async () => {
    const { db, patches, avisos } = montarDb({ fronteiraVencida: true });

    const deps: TickDeps = { db, clock: () => NOW, enqueueJob: async () => {} };
    await avancarEnrollmentAtivo(deps, inscricaoDormente());

    expect(
      patches.some(
        (p) => p.status === "cancelled" && p.cancel_reason === "Atendimento encerrado ou substituído",
      ),
    ).toBe(true);
    expect(avisos.some((a) => a.title === "Um retorno programado não pôde ser enviado")).toBe(true);
  });
});
