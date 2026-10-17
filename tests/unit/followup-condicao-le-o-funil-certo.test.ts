import { describe, expect, it, vi } from "vitest";

import { funilUnicoDasEtapas, idsDeEtapaCitados } from "../../lib/followup/etapas-citadas";
import { avancarEnrollmentAtivo, type AdminClient } from "../../lib/followup/engine";
import type { EnrollmentRow } from "../../lib/followup/node-handlers";
import type { FlowGraph, FlowNode } from "../../lib/followup/graph-schema";

/**
 * Item 11 — a condição por etapa tem de ler a oportunidade do funil CERTO.
 *
 * `loadLeadFacts` escolhia o card do contato pelo `updated_at` mais recente,
 * sem filtrar funil. Medido na instalação do relato (15/10/2026): quatro funis
 * ativos, e dos 2 contatos com card em mais de um deles, nos DOIS o card que o
 * motor escolheria era o de Captação na etapa «Perdido (manter)» — um fluxo de
 * Vendas lia "perdido" e nunca casava a condição.
 *
 * A âncora é o GRAFO: as etapas que ele cita dizem de que funil o fluxo fala.
 * Zero etapas citadas, ou etapas de funis diferentes, devolvem o comportamento
 * de antes — é o que preserva fluxo publicado de outras instalações.
 */

/** Identificadores SINTÉTICOS. Fixture nunca copia id do banco — ver `tests/unit/sem-identificador-de-producao.test.ts`. */
const FUNIL_VENDAS = "22222222-2222-4222-8222-222222222222";
const FUNIL_CAPTACAO = "11111111-1111-4111-8111-111111111111";
const ETAPA_INTERESSADO = "44444444-4444-4444-8444-444444444444";
const ETAPA_AGUARDANDO = "33333333-3333-4333-8333-333333333333";

describe("funilUnicoDasEtapas", () => {
  it("todas as etapas no mesmo funil → é ele", () => {
    expect(funilUnicoDasEtapas([FUNIL_VENDAS, FUNIL_VENDAS])).toBe(FUNIL_VENDAS);
  });

  it("etapas de funis diferentes → null (não há como eleger um sem adivinhar)", () => {
    expect(funilUnicoDasEtapas([FUNIL_VENDAS, FUNIL_CAPTACAO])).toBeNull();
  });

  it("nenhuma etapa → null (o grafo não fala de etapa)", () => {
    expect(funilUnicoDasEtapas([])).toBeNull();
  });

  it("nulos não contam como funil", () => {
    expect(funilUnicoDasEtapas([null, FUNIL_VENDAS, undefined, ""])).toBe(FUNIL_VENDAS);
    expect(funilUnicoDasEtapas([null, null])).toBeNull();
  });

  it("DEGRADA em vez de lançar com resposta que não é lista (falso de Proxy)", () => {
    expect(funilUnicoDasEtapas(null)).toBeNull();
    expect(funilUnicoDasEtapas(undefined)).toBeNull();
    expect(funilUnicoDasEtapas("vendas")).toBeNull();
  });
});

describe("idsDeEtapaCitados — a âncora do funil", () => {
  it("colhe o stage_id de condição por etapa, sem repetir", () => {
    const nodes = [
      {
        id: "c1",
        type: "condition",
        config: {
          combinator: "and",
          checks: [
            { field: "lead_stage", op: "eq", value: ETAPA_INTERESSADO },
            { field: "lead_stage", op: "eq", value: ETAPA_INTERESSADO },
            { field: "tag", op: "eq", value: "vip" },
          ],
        },
      },
    ] as unknown as FlowNode[];
    expect(idsDeEtapaCitados(nodes)).toEqual([ETAPA_INTERESSADO]);
  });

  it("nome digitado à mão (não-uuid) não é consultável e fica de fora", () => {
    const nodes = [
      {
        id: "c1",
        type: "condition",
        config: { combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: "Interessado" }] },
      },
    ] as unknown as FlowNode[];
    expect(idsDeEtapaCitados(nodes)).toEqual([]);
  });
});

const NOW = new Date("2026-10-15T12:00:00.000Z");

/** `TickDeps` completo: o nó de condição não enfileira turno, mas o tipo o exige. */
function deps(db: AdminClient) {
  return { db, clock: () => NOW, enqueueJob: async () => {} };
}

function enrollment(): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contato-1",
    conversation_id: null,
    current_node_id: "cond-1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 1,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
  };
}

function grafo(etapa: string): FlowGraph {
  return {
    nodes: [
      {
        id: "cond-1",
        type: "condition",
        label: "Está na etapa?",
        position: { x: 0, y: 0 },
        config: { combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: etapa }] },
      },
      { id: "sim", type: "end", label: "Sim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      { id: "nao", type: "end", label: "Não", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "e1", source: "cond-1", target: "sim", priority: 0, condition: { type: "cond_result", value: true } },
      { id: "e2", source: "cond-1", target: "nao", priority: 0, condition: { type: "cond_result", value: false } },
    ],
  } as unknown as FlowGraph;
}

/**
 * Banco falso explícito (NÃO `Proxy`): o que está sob medição é justamente
 * QUAIS argumentos `loadLeadFacts` recebe, e um Proxy que responde a qualquer
 * chave esconderia isso.
 */
function bancoFalso(opts: { funis?: (string | null)[]; comMetodo?: boolean }) {
  const loadLeadFacts = vi.fn(async () => ({ lead_stage: ETAPA_INTERESSADO, tags: [] }));
  const loadFunisDasEtapas = vi.fn(async () => opts.funis ?? []);
  const db: Record<string, unknown> = {
    loadFlowGraph: async () => grafo(ETAPA_INTERESSADO),
    loadLeadFacts,
    loadEnrollmentEvents: async () => [],
    loadLastInboundBody: async () => null,
    loadFlowPointerName: async () => null,
    insertEnrollmentEvent: async () => ({ inserted: true }),
    updateEnrollment: async () => {},
    applyEnrollmentStep: async () => {},
    assertServiceBoundary: async () => {},
    assertAgenda: async () => {},
    retornoQueSeguraOFluxo: async () => null,
  };
  if (opts.comMetodo !== false) db.loadFunisDasEtapas = loadFunisDasEtapas;
  return { db: db as unknown as AdminClient, loadLeadFacts, loadFunisDasEtapas };
}

describe("o motor recorta a oportunidade pelo funil do fluxo", () => {
  it("grafo cita etapa de Vendas → loadLeadFacts recebe o funil de Vendas", async () => {
    const { db, loadLeadFacts, loadFunisDasEtapas } = bancoFalso({ funis: [FUNIL_VENDAS] });

    await avancarEnrollmentAtivo(deps(db), enrollment());

    expect(loadFunisDasEtapas).toHaveBeenCalledWith("org-1", [ETAPA_INTERESSADO]);
    expect(loadLeadFacts).toHaveBeenCalledWith("org-1", "contato-1", FUNIL_VENDAS);
  });

  it("etapas de funis diferentes → sem recorte (comportamento de antes)", async () => {
    const { db, loadLeadFacts } = bancoFalso({ funis: [FUNIL_VENDAS, FUNIL_CAPTACAO] });

    await avancarEnrollmentAtivo(deps(db), enrollment());

    expect(loadLeadFacts).toHaveBeenCalledWith("org-1", "contato-1", null);
  });

  it("adaptador sem o método → sem recorte, e sem quebrar", async () => {
    const { db, loadLeadFacts, loadFunisDasEtapas } = bancoFalso({ comMetodo: false });

    await avancarEnrollmentAtivo(deps(db), enrollment());

    expect(loadFunisDasEtapas).not.toHaveBeenCalled();
    expect(loadLeadFacts).toHaveBeenCalledWith("org-1", "contato-1", null);
  });
});
