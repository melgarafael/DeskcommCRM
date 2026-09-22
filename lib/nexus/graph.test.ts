import { describe, expect, it } from "vitest";

import {
  buildIntelligenceGraph,
  buildSelectionContext,
  explainNode,
  priorizarClientes,
  type NexusIntelligenceInput,
  type NexusRadarRow,
} from "./graph";

/** Identidade: os testes afirmam a ESTRUTURA, não o idioma. */
const t = (s: string) => s;

const CLIENTE_A: NexusRadarRow = {
  contact_id: "11111111-1111-1111-1111-111111111111",
  nome: "Auto Peças Silva",
  cidade: "Canoinhas",
  uf: "SC",
  situacao: "em_risco",
  dias_sem_compra: 34,
  atraso_dias: 16,
  ultima_compra: "2026-08-18",
  faturamento_cents: 120000,
  ticket_medio_cents: 40000,
  intervalo_mediano_dias: 18,
  qtd_pedidos: 3,
};

const CLIENTE_B: NexusRadarRow = {
  contact_id: "22222222-2222-2222-2222-222222222222",
  nome: "Mercado Central",
  cidade: "Canoinhas",
  uf: "SC",
  situacao: "ok",
  dias_sem_compra: 5,
  atraso_dias: 0,
  ultima_compra: "2026-09-16",
  faturamento_cents: 50000,
  ticket_medio_cents: 25000,
  intervalo_mediano_dias: 12,
  qtd_pedidos: 2,
};

function entrada(parcial: Partial<NexusIntelligenceInput>): NexusIntelligenceInput {
  return {
    radar: [],
    risks: [],
    knowledge: [],
    memory: [],
    evolution: null,
    ...parcial,
  };
}

describe("priorizarClientes", () => {
  it("risco antes de ok, mesmo fora de ordem", () => {
    expect(priorizarClientes([CLIENTE_B, CLIENTE_A])[0]?.contact_id).toBe(CLIENTE_A.contact_id);
  });
});

describe("buildIntelligenceGraph", () => {
  it("exclui clientes em dia e liga cliente→situação→região com fatos", () => {
    const g = buildIntelligenceGraph(entrada({ radar: [CLIENTE_A, CLIENTE_B] }), t);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has(`cliente:${CLIENTE_A.contact_id}`)).toBe(true);
    expect(ids.has(`cliente:${CLIENTE_B.contact_id}`)).toBe(false);
    expect(ids.has("situacao:em_risco")).toBe(true);
    expect(ids.has("regiao:Canoinhas/SC")).toBe(true);
    const aresta = g.edges.find((e) => e.source === `cliente:${CLIENTE_A.contact_id}`);
    expect(aresta?.inferred).toBe(false);
  });

  it("deriva insight de recompra citando mediana (inferido, com fonte)", () => {
    const g = buildIntelligenceGraph(entrada({ radar: [CLIENTE_A] }), t);
    const insight = g.nodes.find((n) => n.id === "insight:recompra");
    expect(insight?.inferred).toBe(true);
    expect(insight?.detail).toContain("intervalo mediano");
    const aresta = g.edges.find((e) => e.target === "insight:recompra");
    expect(aresta?.label).toContain("34d");
    expect(aresta?.label).toContain("18d");
  });

  it("liga risco ao cliente quando o contato coincide", () => {
    const g = buildIntelligenceGraph(
      entrada({
        radar: [CLIENTE_A],
        risks: [
          {
            id: "lead-1",
            title: "Orçamento parado",
            contact_id: CLIENTE_A.contact_id,
            contact_name: "Auto Peças Silva",
            risk: "critico",
            hours_since_activity: 50,
          },
        ],
      }),
      t,
    );
    expect(
      g.edges.some(
        (e) => e.source === "risco:lead-1" && e.target === `cliente:${CLIENTE_A.contact_id}`,
      ),
    ).toBe(true);
  });

  it("sem dados, grafo vazio sem quebrar (nunca inventa nó)", () => {
    const g = buildIntelligenceGraph(entrada({}), t);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });
});

describe("buildSelectionContext", () => {
  it("combina nós em contexto estruturado com resumo legível", () => {
    const g = buildIntelligenceGraph(entrada({ radar: [CLIENTE_A] }), t);
    const ctx = buildSelectionContext(
      g.nodes.filter((n) => n.kind === "cliente" || n.kind === "regiao"),
      t,
    );
    expect(ctx.clientes).toHaveLength(1);
    expect(ctx.clientes[0]?.nome).toContain("Auto Peças Silva");
    expect(ctx.regioes).toEqual(["Canoinhas/SC"]);
    expect(ctx.resumo).toContain("Canoinhas/SC");
  });
});

describe("explainNode", () => {
  it("explica cliente só com fatos do nó", () => {
    const g = buildIntelligenceGraph(entrada({ radar: [CLIENTE_A] }), t);
    const no = g.nodes.find((n) => n.kind === "cliente");
    expect(no && explainNode(no, t)).toContain("34");
  });
});
