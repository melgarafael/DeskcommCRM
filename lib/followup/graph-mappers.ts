import type { Node, Edge } from "@xyflow/react";

import type { FlowGraph, FlowNode, FlowEdge, NodeType } from "./graph-schema";

/**
 * FlowGraph (Task 2.1) ⇄ React Flow node/edge arrays for the visual builder
 * (Task 6.2). Pure, no DB. React Flow's own `Node`/`Edge` shapes carry
 * id/type/position/data — `label` and `config` live under `data` because RF
 * has no first-class slot for them, everything else maps 1:1.
 */

export type RFNodeData = { label: string; config: FlowNode["config"] };
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

function toFlowNode(n: RFNode): FlowNode {
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
