import { describe, it, expect } from "vitest";

import { layoutFlowGraph, LAYOUT_NODE_WIDTH, LAYOUT_NODE_HEIGHT } from "./auto-layout";
import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";

function trigger(id: string, x = 0, y = 0): FlowNode {
  return { id, type: "trigger", label: "Início", position: { x, y }, config: {} };
}
function wait(id: string, x = 0, y = 0): FlowNode {
  return {
    id,
    type: "wait",
    label: "Aguardar",
    position: { x, y },
    config: { mode: "fixed", duration_ms: 300_000 },
  };
}
function action(id: string, x = 0, y = 0): FlowNode {
  return {
    id,
    type: "action",
    label: "Enviar",
    position: { x, y },
    config: { mode: "ai_message", prompt_hint: "oi" },
  };
}
function end(id: string, x = 0, y = 0): FlowNode {
  return { id, type: "end", label: "Fim", position: { x, y }, config: { outcome: "exhausted" } };
}
function classify(id: string, classes: string[], x = 0, y = 0): FlowNode {
  return {
    id,
    type: "ai_classify",
    label: "Classificar",
    position: { x, y },
    config: { classes, grace_timeout_ms: 900_000, target: "last_reply" },
  };
}
function condition(id: string, x = 0, y = 0): FlowNode {
  return {
    id,
    type: "condition",
    label: "Verificar",
    position: { x, y },
    config: { combinator: "and", checks: [{ field: "steps_taken", op: "gte", value: 0 }] },
  };
}
function always(id: string, source: string, target: string): FlowEdge {
  return { id, source, target, priority: 0, condition: { type: "always" } };
}
function condTrue(id: string, source: string, target: string): FlowEdge {
  return { id, source, target, priority: 0, condition: { type: "cond_result", value: true } };
}
function condFalse(id: string, source: string, target: string): FlowEdge {
  return { id, source, target, priority: 0, condition: { type: "cond_result", value: false } };
}
function classMatch(id: string, source: string, target: string, value: string): FlowEdge {
  return { id, source, target, priority: 0, condition: { type: "class_match", value } };
}

function pos(graph: { nodes: FlowNode[] }, id: string): { x: number; y: number } {
  return graph.nodes.find((n) => n.id === id)!.position;
}

/** Cruzamentos geométricos pelo X: arestas (a→c, b→d) cruzam se as pontas invertem. */
function countCrossings(graph: { nodes: FlowNode[]; edges: FlowEdge[] }): number {
  const p = new Map(graph.nodes.map((n) => [n.id, n.position]));
  let n = 0;
  for (let i = 0; i < graph.edges.length; i++) {
    for (let j = i + 1; j < graph.edges.length; j++) {
      const a = graph.edges[i]!;
      const b = graph.edges[j]!;
      if (a.source === b.source || a.target === b.target) continue;
      if (a.source === b.target || a.target === b.source) continue;
      const ax = p.get(a.source)?.x;
      const bx = p.get(b.source)?.x;
      const cx = p.get(a.target)?.x;
      const dx = p.get(b.target)?.x;
      if (ax === undefined || bx === undefined || cx === undefined || dx === undefined) continue;
      if ((ax - bx) * (cx - dx) < 0) n += 1;
    }
  }
  return n;
}

describe("layoutFlowGraph", () => {
  it("grafo vazio e nó único não quebram e ancoram na origem", () => {
    const empty = layoutFlowGraph({ nodes: [], edges: [] });
    expect(empty.nodes).toEqual([]);

    const one: FlowGraph = { nodes: [trigger("t", 400, 200)], edges: [] };
    const laid = layoutFlowGraph(one);
    expect(pos(laid, "t")).toEqual({ x: 0, y: 0 });
  });

  it("cadeia trigger→wait→action→end vira uma coluna: mesmo X, Y crescente", () => {
    const graph: FlowGraph = {
      nodes: [end("e", 900, 10), wait("w", 40, 800), trigger("t", 700, 500), action("a", 10, 10)],
      edges: [always("e1", "t", "w"), always("e2", "w", "a"), always("e3", "a", "e")],
    };
    const laid = layoutFlowGraph(graph);
    const t = pos(laid, "t");
    const w = pos(laid, "w");
    const a = pos(laid, "a");
    const e = pos(laid, "e");
    expect(t.x).toBe(w.x);
    expect(w.x).toBe(a.x);
    expect(a.x).toBe(e.x);
    expect(t.y).toBeLessThan(w.y);
    expect(w.y).toBeLessThan(a.y);
    expect(a.y).toBeLessThan(e.y);
    expect(w.y - t.y).toBe(LAYOUT_NODE_HEIGHT + 80);
  });

  it("filhos de um classificador ficam na mesma camada, na ordem dos ramos", () => {
    const graph: FlowGraph = {
      nodes: [
        trigger("t", 0, 0),
        classify("c", ["hot", "cold"], 0, 0),
        action("hot", 0, 0),
        action("cold", 0, 0),
        end("else", 0, 0),
      ],
      edges: [
        always("e0", "t", "c"),
        classMatch("e1", "c", "hot", "hot"),
        classMatch("e2", "c", "cold", "cold"),
        always("e3", "c", "else"),
      ],
    };
    const laid = layoutFlowGraph(graph);
    expect(pos(laid, "t").y).toBeLessThan(pos(laid, "c").y);
    expect(pos(laid, "c").y).toBeLessThan(pos(laid, "hot").y);
    expect(pos(laid, "hot").y).toBe(pos(laid, "cold").y);
    expect(pos(laid, "cold").y).toBe(pos(laid, "else").y);
    expect(pos(laid, "hot").x).toBeLessThan(pos(laid, "cold").x);
    expect(pos(laid, "cold").x).toBeLessThan(pos(laid, "else").x);
    expect(pos(laid, "cold").x - pos(laid, "hot").x).toBe(LAYOUT_NODE_WIDTH + 48);
    // Bolinha à direita: o primeiro filho não pode ficar à esquerda do pai —
    // senão a aresta dá a volta e a etiqueta cruza a aresta do ramo vizinho.
    expect(pos(laid, "hot").x).toBeGreaterThanOrEqual(pos(laid, "c").x + LAYOUT_NODE_WIDTH);
  });

  it("filhos de uma condição ficam à direita do pai, no corredor da etiqueta", () => {
    const graph: FlowGraph = {
      nodes: [
        trigger("t"),
        condition("c"),
        action("sim"),
        end("nao"),
      ],
      edges: [
        always("e0", "t", "c"),
        condTrue("e1", "c", "sim"),
        condFalse("e2", "c", "nao"),
      ],
    };
    const laid = layoutFlowGraph(graph);
    expect(pos(laid, "sim").x).toBeGreaterThanOrEqual(pos(laid, "c").x + LAYOUT_NODE_WIDTH);
    expect(pos(laid, "nao").x).toBeGreaterThan(pos(laid, "sim").x);
    expect(pos(laid, "sim").y).toBeGreaterThan(pos(laid, "c").y);
  });

  it("rótulo de aresta mais comprido alarga o corredor à direita do pai", () => {
    const curto = layoutFlowGraph({
      nodes: [classify("c", ["ok"]), action("hot"), end("else")],
      edges: [classMatch("e1", "c", "hot", "ok"), always("e2", "c", "else")],
    });
    const longo = layoutFlowGraph({
      nodes: [classify("c", ["cliente-premium-muito-interessado"]), action("hot"), end("else")],
      edges: [
        classMatch("e1", "c", "hot", "cliente-premium-muito-interessado"),
        always("e2", "c", "else"),
      ],
    });
    const gap = (g: { nodes: FlowNode[] }) => pos(g, "hot").x - pos(g, "c").x;
    expect(gap(longo)).toBeGreaterThan(gap(curto));
  });

  it("desfaz cruzamento de duas arestas entre camadas vizinhas", () => {
    const crossed: FlowGraph = {
      nodes: [trigger("p1", 0, 0), wait("p2", 200, 0), action("c1", 0, 200), end("c2", 200, 200)],
      edges: [always("e1", "p1", "c2"), always("e2", "p2", "c1")],
    };
    expect(countCrossings(crossed)).toBeGreaterThan(0);
    const laid = layoutFlowGraph(crossed);
    expect(countCrossings(laid)).toBe(0);
  });

  it("ciclo do repeat não explode e o corpo fica abaixo do repeat", () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: "r",
          type: "repeat",
          label: "Repetir",
          position: { x: 50, y: 50 },
          config: { max_count: 3 },
        },
        wait("w", 0, 0),
        end("e", 0, 0),
      ],
      edges: [
        { id: "body", source: "r", target: "w", priority: 0, condition: { type: "branch", branch_id: "body" } },
        always("back", "w", "r"),
        { id: "done", source: "r", target: "e", priority: 0, condition: { type: "branch", branch_id: "done" } },
      ],
    };
    const laid = layoutFlowGraph(graph);
    expect(pos(laid, "r").y).toBeLessThan(pos(laid, "w").y);
    expect(laid.nodes).toHaveLength(3);
  });

  it("nós soltos empilham na ordem da paleta, ocupando uma coluna", () => {
    const graph: FlowGraph = {
      nodes: [end("e", 800, 10), action("a", 10, 400), wait("w", 300, 10), trigger("t", 900, 900)],
      edges: [],
    };
    const laid = layoutFlowGraph(graph);
    expect(pos(laid, "t").x).toBe(pos(laid, "w").x);
    expect(pos(laid, "t").y).toBeLessThan(pos(laid, "w").y);
    expect(pos(laid, "w").y).toBeLessThan(pos(laid, "a").y);
    expect(pos(laid, "a").y).toBeLessThan(pos(laid, "e").y);
  });

  it("é idempotente e não muta o grafo de entrada", () => {
    const graph: FlowGraph = {
      nodes: [trigger("t", 12, 34), wait("w", 56, 78)],
      edges: [always("e1", "t", "w")],
    };
    const snapshot = structuredClone(graph);
    const once = layoutFlowGraph(graph);
    const twice = layoutFlowGraph(once);
    expect(graph).toEqual(snapshot);
    expect(pos(twice, "t")).toEqual(pos(once, "t"));
    expect(pos(twice, "w")).toEqual(pos(once, "w"));
    expect(once.edges).toEqual(graph.edges);
  });
});
