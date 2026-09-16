import { describe, expect, it } from "vitest";

import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";
import { mapearChecklist, situacaoDoChecklist, type ChecklistDeAtendimento } from "./atendimento";

function no(node: Partial<FlowNode> & Pick<FlowNode, "id" | "type" | "config">): FlowNode {
  return { label: node.id, position: { x: 0, y: 0 }, ...node } as FlowNode;
}

function aresta(source: string, target: string): FlowEdge {
  return { id: `${source}-${target}`, source, target, priority: 0, condition: { type: "always" } };
}

function grafo(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { nodes, edges } as FlowGraph;
}

const collect = (id: string, key: string, required = true) =>
  no({ id, type: "collect", config: { key, label: key, type: "text", required, permite_correcao: true } });
const skill = (id: string, nome: string) => no({ id, type: "skill", config: { skill_name: nome } });
const trigger = (id: string) => no({ id, type: "trigger", config: {} });
const end = (id: string) => no({ id, type: "end", config: { outcome: "converted" } });

describe("mapearChecklist", () => {
  it("lê a sequência trigger → pergunta → skill → fim", () => {
    const r = mapearChecklist(
      grafo(
        [trigger("t"), collect("c1", "cidade"), skill("s1", "catalogo-apresentacao"), end("e")],
        [aresta("t", "c1"), aresta("c1", "s1"), aresta("s1", "e")],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checklist.passos.map((p) => p.kind)).toEqual(["collect", "skill"]);
      expect(r.checklist.fim.id).toBe("e");
    }
  });

  it("recusa ramificação (mais de uma saída)", () => {
    const r = mapearChecklist(
      grafo(
        [trigger("t"), collect("c1", "cidade"), collect("c2", "cnh"), end("e")],
        [aresta("t", "c1"), aresta("t", "c2"), aresta("c1", "e"), aresta("c2", "e")],
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("recusa nó que não é do atendimento", () => {
    const wait = no({ id: "w", type: "wait", config: { mode: "fixed", duration_ms: 300_000 } });
    const r = mapearChecklist(grafo([trigger("t"), wait, end("e")], [aresta("t", "w"), aresta("w", "e")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain("wait");
  });

  it("recusa ciclo", () => {
    const r = mapearChecklist(
      grafo([trigger("t"), collect("c1", "cidade"), end("e")], [aresta("t", "c1"), aresta("c1", "t")]),
    );
    expect(r.ok).toBe(false);
  });

  it("recusa sem gatilho único", () => {
    const r = mapearChecklist(grafo([collect("c1", "cidade"), end("e")], [aresta("c1", "e")]));
    expect(r.ok).toBe(false);
  });

  it("recusa quando não chega ao Fim", () => {
    const r = mapearChecklist(grafo([trigger("t"), collect("c1", "cidade")], [aresta("t", "c1")]));
    expect(r.ok).toBe(false);
  });
});

describe("situacaoDoChecklist", () => {
  const checklist: ChecklistDeAtendimento = {
    passos: [
      { kind: "collect", node: collect("c1", "cidade") as Extract<FlowNode, { type: "collect" }> },
      { kind: "skill", node: skill("s1", "catalogo-apresentacao") as Extract<FlowNode, { type: "skill" }> },
      { kind: "collect", node: collect("c2", "cnh") as Extract<FlowNode, { type: "collect" }> },
      { kind: "collect", node: collect("c3", "obs", false) as Extract<FlowNode, { type: "collect" }> },
    ],
    fim: end("e") as Extract<FlowNode, { type: "end" }>,
  };

  it("sem valores: tudo pendente e incompleto", () => {
    const s = situacaoDoChecklist(checklist, new Set());
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["cidade", "cnh", "obs"]);
    expect(s.obrigatoriosPendentes.map((n) => n.config.key)).toEqual(["cidade", "cnh"]);
    expect(s.skills).toEqual(["catalogo-apresentacao"]);
    expect(s.completo).toBe(false);
  });

  it("com os obrigatórios preenchidos: completo, mesmo faltando a opcional", () => {
    const s = situacaoDoChecklist(checklist, new Set(["cidade", "cnh"]));
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["obs"]);
    expect(s.completo).toBe(true);
  });

  it("com tudo preenchido: sem pendentes", () => {
    const s = situacaoDoChecklist(checklist, new Set(["cidade", "cnh", "obs"]));
    expect(s.pendentes).toHaveLength(0);
    expect(s.completo).toBe(true);
  });

  it("pergunta sem resposta que atingiu o teto vira esgotada e não bloqueia", () => {
    const s = situacaoDoChecklist(checklist, new Set(), {
      tentativas: { cidade: 3, cnh: 3 },
      maxTentativas: 3,
    });
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["obs"]);
    expect(s.esgotadas.map((n) => n.config.key)).toEqual(["cidade", "cnh"]);
    expect(s.completo).toBe(true);
  });

  it("abaixo do teto continua pendente", () => {
    const s = situacaoDoChecklist(checklist, new Set(), {
      tentativas: { cidade: 2 },
      maxTentativas: 3,
    });
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["cidade", "cnh", "obs"]);
    expect(s.esgotadas).toHaveLength(0);
    expect(s.completo).toBe(false);
  });
});
