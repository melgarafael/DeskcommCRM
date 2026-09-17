import { describe, it, expect, vi } from "vitest";

import {
  processNode,
  ultimoDesfechoDe,
  type EnrollmentEventRef,
  type EnrollmentRow,
  type LeadFacts,
} from "../../lib/followup/node-handlers";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "../../lib/followup/engine";
import type { FlowEdge, FlowGraph, FlowNode } from "../../lib/followup/graph-schema";

/**
 * Issue #527 — a condição por "Desfecho do passo anterior".
 *
 * Dois defeitos, um de dado e um de avaliação:
 *  1. o motor montava `LeadFacts.last_outcome` como `null` FIXO — o desfecho
 *     escolhido no passo anterior nunca chegava à condição (decorativa);
 *  2. `neq` sobre `null` respondia `true`, então "não foi X" mandava TODO lead
 *     pelo ramo da negativa — inclusive o que nunca foi classificado.
 */

const NOW = new Date("2026-09-17T12:00:00.000Z");
const clock = () => NOW;

function enrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: null,
    current_node_id: "cond-1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 4,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function lead(overrides: Partial<LeadFacts> = {}): LeadFacts {
  return { lead_stage: null, tags: [], steps_taken: 4, last_outcome: null, ...overrides };
}

let seq = 0;
function evento(event_type: string, payload: Record<string, unknown> = {}): EnrollmentEventRef {
  seq += 1;
  return { node_id: "class-1", idempotency_key: `idem-${seq}`, event_type, payload };
}

function condicao(
  checks: Array<{ id?: string; field: string; op: string; value: string | number }>,
  combinator: "and" | "or" = "and",
): FlowNode {
  return {
    id: "cond-1",
    type: "condition",
    config: { checks, combinator },
  } as unknown as FlowNode;
}

function edge(overrides: Partial<FlowEdge> & Pick<FlowEdge, "source" | "target" | "condition">): FlowEdge {
  return { id: `${overrides.source}->${overrides.target}`, priority: 0, ...overrides };
}

const EDGES: FlowEdge[] = [
  edge({ source: "cond-1", target: "sim", condition: { type: "cond_result", value: true } }),
  edge({ source: "cond-1", target: "nao", condition: { type: "cond_result", value: false } }),
];

/** Roda a condição e devolve o nó escolhido — é a decisão que o motor toma num tick. */
function rotaDoNo(node: FlowNode, facts: LeadFacts, edges: FlowEdge[] = EDGES): string | null {
  const result = processNode({
    node,
    edges,
    enrollment: enrollment(),
    lead: facts,
    clock,
    waitElapsed: false,
    wokeEarly: false,
    lastInboundBody: null,
    actionEnqueued: false,
    actionRecheckCount: 0,
    actionCompleted: false,
    smartWaits: [],
    planEnqueued: false,
    planRecheckCount: 0,
    repeatTaken: [],
    repeatTotal: [],
    proximo: null,
  } as unknown as Parameters<typeof processNode>[0]);
  const decision = result as { kind: string; next_node_id?: string };
  return decision.kind === "advance" ? (decision.next_node_id ?? null) : null;
}

const NAO_FOI_QUENTE = condicao([{ field: "last_outcome", op: "neq", value: "quente" }]);

describe("ultimoDesfechoDe — o desfecho do passo anterior é lido dos eventos", () => {
  it("sem nenhuma classificação o desfecho é null, não 'não é X'", () => {
    expect(ultimoDesfechoDe([])).toBeNull();
    expect(ultimoDesfechoDe([evento("wait_elapsed"), evento("turn_enqueued", { job_id: "j1" })])).toBeNull();
  });

  it("vale a classe do ai_classified MAIS RECENTE, não a primeira da inscrição", () => {
    const eventos = [
      evento("ai_classified", { class: "frio" }),
      evento("turn_enqueued", { job_id: "j2" }),
      evento("ai_classified", { class: "quente" }),
    ];
    expect(ultimoDesfechoDe(eventos)).toBe("quente");
  });

  it("classificação sem classe no payload não apaga o desfecho anterior", () => {
    const eventos = [evento("ai_classified", { class: "quente" }), evento("ai_classified", {})];
    expect(ultimoDesfechoDe(eventos)).toBe("quente");
  });
});

describe("condição por desfecho do passo anterior — negativa não é decorativa (#527)", () => {
  it("desfecho diferente do valor: segue pelo ramo da negativa (verdadeiro)", () => {
    expect(rotaDoNo(NAO_FOI_QUENTE, lead({ last_outcome: "frio" }))).toBe("sim");
  });

  it("desfecho igual ao valor: nega a negação e cai no ramo falso", () => {
    expect(rotaDoNo(NAO_FOI_QUENTE, lead({ last_outcome: "quente" }))).toBe("nao");
  });

  it("lead SEM classificação não satisfaz 'não foi X' — antes satisfazia e TODO lead passava", () => {
    expect(rotaDoNo(NAO_FOI_QUENTE, lead({ last_outcome: null }))).toBe("nao");
  });

  it("o mesmo vale para o campo nulo lead_stage, que é condição legítima de fluxo", () => {
    const semEstagio = condicao([{ field: "lead_stage", op: "neq", value: "cliente" }]);
    expect(rotaDoNo(semEstagio, lead({ lead_stage: null }))).toBe("nao");
    expect(rotaDoNo(semEstagio, lead({ lead_stage: "lead" }))).toBe("sim");
    expect(rotaDoNo(semEstagio, lead({ lead_stage: "cliente" }))).toBe("nao");
  });

  it("combinador `and` com dois checks: só passa quem foi classificado fora do valor", () => {
    const no = condicao([
      { field: "last_outcome", op: "neq", value: "quente" },
      { field: "tag", op: "contains", value: "interessado" },
    ]);
    expect(rotaDoNo(no, lead({ last_outcome: null, tags: ["interessado"] }))).toBe("nao");
    expect(rotaDoNo(no, lead({ last_outcome: "frio", tags: [] }))).toBe("nao");
    expect(rotaDoNo(no, lead({ last_outcome: "frio", tags: ["interessado"] }))).toBe("sim");
  });

  it("a afirmativa segue negando ausência de dado (nada mudou aqui)", () => {
    const foiQuente = condicao([{ field: "last_outcome", op: "eq", value: "quente" }]);
    expect(rotaDoNo(foiQuente, lead({ last_outcome: null }))).toBe("nao");
    expect(rotaDoNo(foiQuente, lead({ last_outcome: "quente" }))).toBe("sim");
  });
});

describe("motor: o passo anterior alimenta o desfecho lido no tick seguinte (#527)", () => {
  const GRAFO = {
    nodes: [
      { id: "cond-1", type: "condition", config: { checks: [{ field: "last_outcome", op: "neq", value: "quente" }], combinator: "and" } },
      { id: "sim", type: "end", config: { outcome: "converted" } },
      { id: "nao", type: "end", config: { outcome: "exhausted" } },
    ],
    edges: EDGES,
  } as unknown as FlowGraph;

  /** Banco falso: só o que o tick do nó de condição precisa, com tudo espiável. */
  function bancoFalso(eventos: EnrollmentEventRef[]) {
    const passos: Array<Record<string, unknown>> = [];
    const registrar = (patch: Record<string, unknown>) => passos.push(patch);
    const base = {
      loadFlowGraph: vi.fn(async () => GRAFO),
      loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
      loadEnrollmentEvents: vi.fn(async () => eventos),
      loadLastInboundBody: vi.fn(async () => null),
      loadFlowPointerName: vi.fn(async () => null),
      insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
      updateEnrollment: vi.fn(async (_id: string, _org: string, patch: Record<string, unknown>) => registrar(patch)),
      applyEnrollmentStep: vi.fn(async (_id: string, _org: string, patch: Record<string, unknown>) => registrar(patch)),
    } as Record<string, unknown>;
    const db = new Proxy(base, {
      get: (alvo, chave) => alvo[chave as string] ?? (async () => null),
    }) as unknown as AdminClient;
    return { db, passos };
  }

  async function rodarTick(eventos: EnrollmentEventRef[]) {
    const { db, passos } = bancoFalso(eventos);
    const deps: TickDeps = { db, clock, enqueueJob: async () => {} };
    await avancarEnrollmentAtivo(deps, enrollment());
    const destino = passos.map((p) => p.current_node_id).filter((n): n is string => typeof n === "string");
    return { destino, eventosLidos: (db.loadEnrollmentEvents as unknown as { mock: { calls: unknown[] } }).mock.calls.length };
  }

  it("com o passo anterior classificado 'quente', 'não foi quente' leva ao ramo falso", async () => {
    const { destino } = await rodarTick([evento("ai_classified", { class: "quente", node_id: "class-1" })]);
    expect(destino).toContain("nao");
    expect(destino).not.toContain("sim");
  });

  it("com o passo anterior classificado 'frio', 'não foi quente' leva ao ramo verdadeiro", async () => {
    const { destino } = await rodarTick([evento("ai_classified", { class: "frio", node_id: "class-1" })]);
    expect(destino).toContain("sim");
    expect(destino).not.toContain("nao");
  });

  it("lead sem nenhum ai_classified não passa pela negativa (ausência não é prova)", async () => {
    const { destino, eventosLidos } = await rodarTick([evento("wait_elapsed")]);
    expect(eventosLidos).toBeGreaterThan(0);
    expect(destino).toContain("nao");
  });
});
