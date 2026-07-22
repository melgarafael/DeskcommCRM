import type { Node, Edge } from "@xyflow/react";

import type { FlowGraph, FlowNode, FlowEdge, NodeType } from "./graph-schema";

/**
 * FlowGraph (Task 2.1) ⇄ React Flow node/edge arrays for the visual builder
 * (Task 6.2). Pure, no DB. React Flow's own `Node`/`Edge` shapes carry
 * id/type/position/data — `label` and `config` live under `data` because RF
 * has no first-class slot for them, everything else maps 1:1.
 */

// `errors` is UI-only (Task 6.2 — publish 422 anchored to the offending node),
// never read/written by the mappers below; `data` is `Record<string, unknown>`
// per @xyflow/react's Node<NodeData> constraint, so it can't be dropped here.
export type RFNodeData = { label: string; config: FlowNode["config"]; errors?: string[] };
export type RFNode = Node<RFNodeData, NodeType>;

export type RFEdgeData = { priority: number; condition: FlowEdge["condition"] };
export type RFEdge = Edge<RFEdgeData>;

export function toReactFlow(graph: FlowGraph): { nodes: RFNode[]; edges: RFEdge[] } {
  const nodes: RFNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    data: { label: n.label, config: n.config },
  }));
  const edges: RFEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    data: { priority: e.priority, condition: e.condition },
  }));
  return { nodes, edges };
}

/** Extracts the config type belonging to a single arm of the FlowNode union. */
type ConfigOf<T extends NodeType> = Extract<FlowNode, { type: T }>["config"];

/** Exported for the edge condition panel (Task 6.3) — reads a live RFNode's classes/config as a FlowNode. */
export function toFlowNode(n: RFNode): FlowNode {
  const shared = {
    id: n.id,
    label: n.data.label,
    position: { x: n.position.x, y: n.position.y },
  };
  const type = n.type as NodeType;
  switch (type) {
    case "trigger":
      return { ...shared, type, config: n.data.config as ConfigOf<"trigger"> };
    case "wait":
      return { ...shared, type, config: n.data.config as ConfigOf<"wait"> };
    case "condition":
      return { ...shared, type, config: n.data.config as ConfigOf<"condition"> };
    case "ai_classify":
      return { ...shared, type, config: n.data.config as ConfigOf<"ai_classify"> };
    case "action":
      return { ...shared, type, config: n.data.config as ConfigOf<"action"> };
    case "end":
      return { ...shared, type, config: n.data.config as ConfigOf<"end"> };
    default: {
      const exhaustive: never = type;
      throw new Error(`unknown node type: ${String(exhaustive)}`);
    }
  }
}

/** Deep-equal with sorted object keys — safe against key-order drift across a jsonb round trip. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Used by the builder's dirty-state indicator (PublishBar, Task 6.2) — not order-sensitive. */
export function graphsEqual(a: FlowGraph, b: FlowGraph): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function fromReactFlow(nodes: RFNode[], edges: RFEdge[]): FlowGraph {
  return {
    nodes: nodes.map(toFlowNode),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      priority: e.data?.priority ?? 0,
      condition: e.data?.condition ?? { type: "always" },
    })),
  };
}
