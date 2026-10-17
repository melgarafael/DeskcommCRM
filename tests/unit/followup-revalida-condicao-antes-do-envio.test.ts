import { describe, expect, it, vi } from "vitest";

import { condicaoQueGoverna, desvioAntesDoEnvio } from "../../lib/followup/condicao-antes-do-envio";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "../../lib/followup/engine";
import type { EnrollmentRow, LeadFacts } from "../../lib/followup/node-handlers";
import type { FlowEdge, FlowGraph, FlowNode } from "../../lib/followup/graph-schema";

/**
 * Item 13 — a condição é reavaliada no INSTANTE do envio.
 *
 * A condição só era avaliada quando a inscrição estava no nó `condition`. Num
 * grafo normal — "está na etapa X?" -> espera de 48 h -> manda — o lead que saiu
 * da etapa durante a espera recebia a mensagem de qualquer jeito: a decisão
 * tinha dois dias de idade. É o caso comum, não a borda: o fluxo existe para
 * quem NÃO andou, e quem andou é quem mais não pode receber a cobrança.
 */

/** Identificadores SINTÉTICOS. Fixture nunca copia id do banco — ver `tests/unit/sem-identificador-de-producao.test.ts`. */
const ETAPA = "44444444-4444-4444-8444-444444444444";
const OUTRA = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-15T12:00:00.000Z");

function condicao(id = "cond-1", branching?: "per_check"): FlowNode {
  return {
    id,
    type: "condition",
    label: "Está na etapa?",
    position: { x: 0, y: 0 },
    config: {
      combinator: "and",
      ...(branching ? { branching } : {}),
      checks: [{ id: "r1", label: "etapa", field: "lead_stage", op: "eq", value: ETAPA }],
    },
  } as unknown as FlowNode;
}

const ESPERA = {
  id: "wait-1",
  type: "wait",
  label: "48 h",
  position: { x: 0, y: 0 },
  config: { mode: "fixed", duration_ms: 172_800_000 },
} as unknown as FlowNode;

const ENVIO = {
  id: "act-1",
  type: "action",
  label: "Cobra",
  position: { x: 0, y: 0 },
  config: { mode: "text", body: "Ainda tem interesse?" },
} as unknown as FlowNode;

const FIM = {
  id: "fim",
  type: "end",
  label: "Fim",
  position: { x: 0, y: 0 },
  config: { outcome: "exhausted" },
} as unknown as FlowNode;

function aresta(source: string, target: string, condition: FlowEdge["condition"]): FlowEdge {
  return { id: `${source}->${target}`, source, target, priority: 0, condition };
}

/** O grafo do caso real: condição -> espera -> envio, com o ramo do Não indo ao fim. */
const NODES = [condicao(), ESPERA, ENVIO, FIM];
const EDGES = [
  aresta("cond-1", "wait-1", { type: "cond_result", value: true }),
  aresta("cond-1", "fim", { type: "cond_result", value: false }),
  aresta("wait-1", "act-1", { type: "always" }),
];

function lead(stage: string | null): LeadFacts {
  return { lead_stage: stage, tags: [], steps_taken: 2, last_outcome: null };
}

describe("condicaoQueGoverna — sobe pelas arestas atravessando esperas", () => {
  it("acha a condição através da espera, e sabe que o caminho foi o Sim", () => {
    const governa = condicaoQueGoverna(NODES, EDGES, "act-1");
    expect(governa?.condicao.id).toBe("cond-1");
    expect(governa?.esperado).toBe(true);
  });

  it("condição ligada direto ao envio também é achada", () => {
    const edges = [aresta("cond-1", "act-1", { type: "cond_result", value: true })];
    expect(condicaoQueGoverna([condicao(), ENVIO], edges, "act-1")?.esperado).toBe(true);
  });

  it("envio alcançado por DOIS caminhos devolve null (nao ha uma condicao que o governe)", () => {
    const edges = [...EDGES, aresta("fim", "act-1", { type: "always" })];
    expect(condicaoQueGoverna(NODES, edges, "act-1")).toBeNull();
  });

  it("classificacao no caminho devolve null (decisao propria e mais recente)", () => {
    const classify = {
      id: "cls",
      type: "ai_classify",
      label: "c",
      position: { x: 0, y: 0 },
      config: { classes: ["a"], grace_timeout_ms: 900_000, target: "last_reply" },
    } as unknown as FlowNode;
    const edges = [
      aresta("cond-1", "cls", { type: "cond_result", value: true }),
      aresta("cls", "act-1", { type: "always" }),
    ];
    expect(condicaoQueGoverna([condicao(), classify, ENVIO], edges, "act-1")).toBeNull();
  });

  it("modo per_check devolve null (a aresta roteia por regra, nao por booleano)", () => {
    const edges = [aresta("cond-1", "act-1", { type: "cond_result", value: true })];
    expect(condicaoQueGoverna([condicao("cond-1", "per_check"), ENVIO], edges, "act-1")).toBeNull();
  });

  it("saida de escape (always) da condicao nao e promessa de nada: null", () => {
    const edges = [aresta("cond-1", "act-1", { type: "always" })];
    expect(condicaoQueGoverna([condicao(), ENVIO], edges, "act-1")).toBeNull();
  });
});

describe("desvioAntesDoEnvio", () => {
  it("lead continua na etapa devolve null (envia)", () => {
    expect(desvioAntesDoEnvio(NODES, EDGES, "act-1", lead(ETAPA), NOW)).toBeNull();
  });

  it("lead saiu da etapa durante a espera: desvia para o ramo do Nao", () => {
    const desvio = desvioAntesDoEnvio(NODES, EDGES, "act-1", lead(OUTRA), NOW);
    expect(desvio).toEqual({ proximo: "fim", esperado: true, agora: false });
  });

  it("lead sem oportunidade nenhuma tambem desvia (ausencia nao autoriza envio)", () => {
    expect(desvioAntesDoEnvio(NODES, EDGES, "act-1", lead(null), NOW)?.proximo).toBe("fim");
  });

  it("sem aresta desenhada para o novo resultado, volta a condicao e NAO envia", () => {
    const edges = [
      aresta("cond-1", "wait-1", { type: "cond_result", value: true }),
      aresta("wait-1", "act-1", { type: "always" }),
    ];
    expect(desvioAntesDoEnvio(NODES, edges, "act-1", lead(OUTRA), NOW)?.proximo).toBe("cond-1");
  });
});

/* ─── O motor: o envio nao e enfileirado quando a condicao deixou de valer ─── */

function enrollment(): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contato-1",
    conversation_id: "conv-1",
    current_node_id: "act-1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 2,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
  };
}

function bancoFalso(stage: string | null) {
  const eventos: Array<Record<string, unknown>> = [];
  const patches: Array<Record<string, unknown>> = [];
  const db: Record<string, unknown> = {
    loadFlowGraph: async () => ({ nodes: NODES, edges: EDGES }) as unknown as FlowGraph,
    loadLeadFacts: async () => ({ lead_stage: stage, tags: [] }),
    // A espera deste passo já venceu: sem o marcador o nó de ação nem chega a
    // enfileirar, e o caso não mediria nada.
    loadEnrollmentEvents: async () => [
      {
        node_id: "act-1",
        idempotency_key: "act-1:2:wait_started",
        event_type: "wait_started",
        payload: {},
      },
    ],
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
    assertAgenda: async () => {},
    retornoQueSeguraOFluxo: async () => null,
  };
  const enqueueJob = vi.fn(async () => {});
  return {
    deps: { db: db as unknown as AdminClient, clock: () => NOW, enqueueJob } as TickDeps,
    eventos,
    patches,
    enqueueJob,
  };
}

describe("o motor nao envia quando a condicao deixou de valer", () => {
  it("lead saiu da etapa: nenhum turno enfileirado, evento gravado e fluxo desviado", async () => {
    const { deps, eventos, patches, enqueueJob } = bancoFalso(OUTRA);

    await avancarEnrollmentAtivo(deps, enrollment());

    expect(enqueueJob).not.toHaveBeenCalled();
    expect(eventos.some((e) => e.event_type === "condition_revalidated")).toBe(true);
    expect(patches.some((p) => p.current_node_id === "fim")).toBe(true);
  });

  it("lead continua na etapa: o envio segue normalmente", async () => {
    const { deps, eventos, enqueueJob } = bancoFalso(ETAPA);

    await avancarEnrollmentAtivo(deps, enrollment());

    expect(enqueueJob).toHaveBeenCalled();
    expect(eventos.some((e) => e.event_type === "condition_revalidated")).toBe(false);
  });
});

/* ─── O que o fluxo ou o relógio mudam NÃO é reavaliado ───────────────────────
 *
 * `steps_taken` sobe a cada passo, `last_outcome` só é carregado no nó
 * `condition` (no envio é `null`) e `lead_date` é relativo ao relógio. Reavaliar
 * qualquer um deles no envio desviava envio legítimo pelo ramo do Não. */

function condicaoSobre(check: Record<string, unknown>): FlowNode {
  return {
    id: "cond-1",
    type: "condition",
    label: "c",
    position: { x: 0, y: 0 },
    config: { combinator: "and", checks: [{ id: "r1", label: "r", ...check }] },
  } as unknown as FlowNode;
}

function motorCom(opts: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  steps: number;
  eventosExtras?: Array<Record<string, unknown>>;
  custom_fields?: Record<string, unknown>;
}) {
  const eventos: Array<Record<string, unknown>> = [];
  const db: Record<string, unknown> = {
    loadFlowGraph: async () => ({ nodes: opts.nodes, edges: opts.edges }) as unknown as FlowGraph,
    loadLeadFacts: async () => ({ lead_stage: ETAPA, tags: [], custom_fields: opts.custom_fields }),
    loadEnrollmentEvents: async () => [
      ...(opts.eventosExtras ?? []),
      {
        node_id: "act-1",
        idempotency_key: `act-1:${opts.steps}:wait_started`,
        event_type: "wait_started",
        payload: {},
      },
    ],
    loadLastInboundBody: async () => null,
    loadFlowPointerName: async () => null,
    loadRenderContext: async () => null,
    insertEnrollmentEvent: async (e: Record<string, unknown>) => {
      eventos.push(e);
      return { inserted: true };
    },
    updateEnrollment: async () => {},
    applyEnrollmentStep: async () => {},
    assertServiceBoundary: async () => {},
    assertAgenda: async () => {},
    retornoQueSeguraOFluxo: async () => null,
  };
  const enqueueJob = vi.fn(async () => {});
  const deps = { db: db as unknown as AdminClient, clock: () => NOW, enqueueJob } as TickDeps;
  return { run: () => avancarEnrollmentAtivo(deps, { ...enrollment(), steps_taken: opts.steps }), eventos, enqueueJob };
}

const SIM_ESPERA_ENVIO = [
  aresta("cond-1", "wait-1", { type: "cond_result", value: true }),
  aresta("cond-1", "fim", { type: "cond_result", value: false }),
  aresta("wait-1", "act-1", { type: "always" }),
];
const CLASSIFICOU_INTERESSADO = {
  node_id: "cls",
  idempotency_key: "cls:0:ai_classified",
  event_type: "ai_classified",
  payload: { class: "interessado" },
};

describe("campos que o fluxo ou o relógio mudam não desviam o envio", () => {
  it("last_outcome eq interessado → espera → envio: enfileira", async () => {
    const m = motorCom({
      nodes: [condicaoSobre({ field: "last_outcome", op: "eq", value: "interessado" }), ESPERA, ENVIO, FIM],
      edges: SIM_ESPERA_ENVIO,
      steps: 2,
      eventosExtras: [CLASSIFICOU_INTERESSADO],
    });
    await m.run();
    expect(m.enqueueJob).toHaveBeenCalled();
    expect(m.eventos.some((e) => e.event_type === "condition_revalidated")).toBe(false);
  });

  it("last_outcome eq interessado → envio direto, sem espera: enfileira", async () => {
    const m = motorCom({
      nodes: [condicaoSobre({ field: "last_outcome", op: "eq", value: "interessado" }), ENVIO, FIM],
      edges: [
        aresta("cond-1", "act-1", { type: "cond_result", value: true }),
        aresta("cond-1", "fim", { type: "cond_result", value: false }),
      ],
      steps: 2,
      eventosExtras: [CLASSIFICOU_INTERESSADO],
    });
    await m.run();
    expect(m.enqueueJob).toHaveBeenCalled();
    expect(m.eventos.some((e) => e.event_type === "condition_revalidated")).toBe(false);
  });

  it("steps_taken lte 1 → espera → envio com steps=3: enfileira", async () => {
    const m = motorCom({
      nodes: [condicaoSobre({ field: "steps_taken", op: "lte", value: 1 }), ESPERA, ENVIO, FIM],
      edges: SIM_ESPERA_ENVIO,
      steps: 3,
    });
    await m.run();
    expect(m.enqueueJob).toHaveBeenCalled();
    expect(m.eventos.some((e) => e.event_type === "condition_revalidated")).toBe(false);
  });

  it("lead_date falta_para 3 → espera que atravessa o limiar → envio: enfileira", async () => {
    // No envio faltam 2 dias (era ≥3 quando passou pela condição).
    const m = motorCom({
      nodes: [condicaoSobre({ field: "lead_date", op: "falta_para", value: 3, key: "fim_teste" }), ESPERA, ENVIO, FIM],
      edges: SIM_ESPERA_ENVIO,
      steps: 2,
      custom_fields: { fim_teste: "2026-10-17" },
    });
    await m.run();
    expect(m.enqueueJob).toHaveBeenCalled();
    expect(m.eventos.some((e) => e.event_type === "condition_revalidated")).toBe(false);
  });
});
