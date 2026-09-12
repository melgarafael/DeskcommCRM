import {
  branchIdForCondition,
  nodeBranches,
  type FlowEdge,
  type FlowNode,
  type NodeType,
} from "./graph-schema";
import { rotuloDoRamo } from "./rotulo-do-ramo";

/**
 * Empilha o grafo do construtor de follow-up em camadas de cima pra baixo.
 * Ranking pelo caminho mais longo (compacto no eixo Y), ordem inicial pela
 * sequência dos ramos do nó, baricentro pra desfazer cruzamentos. Nó com
 * várias saídas desenha as bolinhas à direita: os filhos ficam nesse corredor,
 * com folga da etiqueta da aresta — senão o primeiro ramo cai à esquerda do
 * pai, o SmoothStep dá a volta e a etiqueta senta em cima da aresta vizinha.
 * Arestas de ciclo (corpo do `repeat` voltando) não entram no ranking — senão
 * o grafo não tem topo.
 *
 * Não usa Dagre/ELK: o canvas já conhece ramos e handles, e uma lib de grafo
 * genérica ignoraria essa ordem. Pure, sem DOM.
 */

export const LAYOUT_NODE_WIDTH = 224;
export const LAYOUT_NODE_HEIGHT = 64;
const BRANCH_ROW_HEIGHT = 26;
const H_GAP = 48;
const V_GAP = 80;
/** Offset padrão do SmoothStep do XYFlow — o primeiro segmento sai da bolinha. */
const SMOOTHSTEP_OFFSET = 20;
const EDGE_LABEL_PAD_X = 20;
const EDGE_LABEL_CHAR_W = 7;
const EDGE_LABEL_WIDTH_MIN = 32;
const EDGE_LABEL_WIDTH_MAX = 160;

const TYPE_ORDER: Record<NodeType, number> = {
  trigger: 0,
  wait: 1,
  condition: 2,
  ai_classify: 3,
  match_reply: 4,
  repeat: 5,
  action: 6,
  end: 7,
};

export type NodeSize = { width: number; height: number };

export function estimateNodeSize(node: FlowNode): NodeSize {
  const branches = nodeBranches(node);
  const height =
    branches.length > 1 ? 48 + branches.length * BRANCH_ROW_HEIGHT : LAYOUT_NODE_HEIGHT;
  return { width: LAYOUT_NODE_WIDTH, height };
}

export function layoutFlowGraph(
  graph: { nodes: FlowNode[]; edges: FlowEdge[] },
  sizes?: ReadonlyMap<string, NodeSize>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (graph.nodes.length === 0) return graph;

  const sizeOf = (id: string, node: FlowNode): NodeSize => sizes?.get(id) ?? estimateNodeSize(node);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const positions = new Map<string, { x: number; y: number }>();

  const components = connectedComponents(graph);
  const connected = components.filter((ids) => ids.length >= 2);
  const orphans = components.filter((ids) => ids.length === 1).map((ids) => ids[0]!);

  connected.sort((a, b) => compareComponents(a, b, byId));

  let cursorX = 0;

  for (const ids of connected) {
    const sub = subgraph(graph, ids);
    const packed = packLayered(sub, sizeOf);
    for (const [id, p] of packed.positions) {
      positions.set(id, { x: p.x + cursorX, y: p.y });
    }
    cursorX += packed.width + H_GAP;
  }

  if (orphans.length > 0) {
    const sorted = [...orphans].sort((a, b) => compareOrphans(byId.get(a)!, byId.get(b)!));
    let y = 0;
    for (const id of sorted) {
      const node = byId.get(id)!;
      const size = sizeOf(id, node);
      positions.set(id, { x: cursorX, y });
      y += size.height + V_GAP;
    }
  }

  return {
    nodes: graph.nodes.map((n) => ({
      ...n,
      position: roundPos(positions.get(n.id) ?? n.position),
    })),
    edges: graph.edges,
  };
}

function roundPos(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function subgraph(
  graph: { nodes: FlowNode[]; edges: FlowEdge[] },
  ids: readonly string[],
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const set = new Set(ids);
  return {
    nodes: graph.nodes.filter((n) => set.has(n.id)),
    edges: graph.edges.filter((e) => set.has(e.source) && set.has(e.target)),
  };
}

function connectedComponents(graph: { nodes: FlowNode[]; edges: FlowEdge[] }): string[][] {
  const parent = new Map<string, string>();
  for (const n of graph.nodes) parent.set(n.id, n.id);
  const find = (id: string): string => {
    const p = parent.get(id)!;
    if (p !== id) parent.set(id, find(p));
    return parent.get(id)!;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of graph.edges) {
    if (parent.has(e.source) && parent.has(e.target)) union(e.source, e.target);
  }
  const groups = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const root = find(n.id);
    const list = groups.get(root) ?? [];
    list.push(n.id);
    groups.set(root, list);
  }
  return [...groups.values()];
}

function compareComponents(a: string[], b: string[], byId: Map<string, FlowNode>): number {
  const aTrig = a.some((id) => byId.get(id)?.type === "trigger") ? 0 : 1;
  const bTrig = b.some((id) => byId.get(id)?.type === "trigger") ? 0 : 1;
  if (aTrig !== bTrig) return aTrig - bTrig;
  if (b.length !== a.length) return b.length - a.length;
  const minA = a.reduce((m, id) => (id < m ? id : m));
  const minB = b.reduce((m, id) => (id < m ? id : m));
  return minA.localeCompare(minB);
}

function compareOrphans(a: FlowNode, b: FlowNode): number {
  const d = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

type SizeOf = (id: string, node: FlowNode) => NodeSize;

function packLayered(
  graph: { nodes: FlowNode[]; edges: FlowEdge[] },
  sizeOf: SizeOf,
): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const forward = uniquePairs(forwardEdges(graph));
  const rank = assignRanks(graph.nodes, forward);
  const order = orderRanks(graph, forward, rank);

  const maxRank = Math.max(0, ...rank.values());
  const layers: string[][] = [];
  for (let r = 0; r <= maxRank; r++) {
    layers.push((order.get(r) ?? []).filter((id) => byId.has(id)));
  }

  const positions = new Map<string, { x: number; y: number }>();
  const layerY: number[] = [];
  let y = 0;
  for (let r = 0; r < layers.length; r++) {
    layerY.push(y);
    const ids = layers[r]!;
    if (ids.length === 0) continue;
    const layerHeight = Math.max(...ids.map((id) => sizeOf(id, byId.get(id)!).height));
    y += layerHeight + V_GAP;
  }
  const totalHeight = y > 0 ? y - V_GAP : 0;

  let maxRight = 0;
  for (let r = 0; r < layers.length; r++) {
    const ids = layers[r]!;
    let cursor = 0;
    for (const id of ids) {
      const node = byId.get(id)!;
      const size = sizeOf(id, node);
      let fromParents = 0;
      for (const e of forward) {
        if (e.target !== id) continue;
        const parent = byId.get(e.source);
        if (!parent) continue;
        const parentPos = positions.get(parent.id);
        if (!parentPos) continue;
        const exit = rightExitGap(parent, graph.edges);
        if (exit <= 0) continue;
        fromParents = Math.max(
          fromParents,
          parentPos.x + sizeOf(parent.id, parent).width + exit,
        );
      }
      const x = Math.max(cursor, fromParents);
      positions.set(id, { x, y: layerY[r]! });
      cursor = x + size.width + Math.max(H_GAP, rightExitGap(node, graph.edges));
      maxRight = Math.max(maxRight, x + size.width);
    }
  }

  return { positions, width: maxRight, height: Math.max(0, totalHeight) };
}

function estimateEdgeLabelWidth(text: string): number {
  return Math.min(
    EDGE_LABEL_WIDTH_MAX,
    Math.max(EDGE_LABEL_WIDTH_MIN, text.length * EDGE_LABEL_CHAR_W + EDGE_LABEL_PAD_X),
  );
}

/** Folga à direita de um nó com bolinhas laterais: offset do SmoothStep + etiqueta. */
function rightExitGap(node: FlowNode, edges: readonly FlowEdge[]): number {
  const branches = nodeBranches(node);
  if (branches.length <= 1) return 0;
  let widest = 0;
  for (const e of edges) {
    if (e.source !== node.id) continue;
    const bid = branchIdForCondition(node, e.condition);
    const branch =
      bid === null
        ? branches.find((b) => b.kind === "fallback")
        : branches.find((b) => b.id === bid);
    const text = branch ? rotuloDoRamo(branch) : "Sempre";
    widest = Math.max(widest, estimateEdgeLabelWidth(text));
  }
  if (widest === 0) return 0;
  return SMOOTHSTEP_OFFSET + widest;
}

/** DFS: aresta pra um ancestral (cinza) é ciclo e sai do ranking. */
function forwardEdges(graph: { nodes: FlowNode[]; edges: FlowEdge[] }): FlowEdge[] {
  const outgoing = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    const list = outgoing.get(e.source) ?? [];
    list.push(e);
    outgoing.set(e.source, list);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const kept: FlowEdge[] = [];

  const visit = (id: string) => {
    color.set(id, 1);
    for (const e of outgoing.get(id) ?? []) {
      const c = color.get(e.target) ?? 0;
      if (c === 1) continue;
      kept.push(e);
      if (c === 0) visit(e.target);
    }
    color.set(id, 2);
  };

  const starts = [...graph.nodes].sort((a, b) => {
    // Gatilho e `repeat` são cabeças: se o DFS começar pelo corpo do loop,
    // a aresta de volta vira a árvore e o header fica abaixo.
    const pri = (n: FlowNode) => (n.type === "trigger" ? 0 : n.type === "repeat" ? 1 : 2);
    const d = pri(a) - pri(b);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  for (const n of starts) {
    if ((color.get(n.id) ?? 0) === 0) visit(n.id);
  }
  return kept;
}

function uniquePairs(edges: FlowEdge[]): Array<{ source: string; target: string }> {
  const seen = new Set<string>();
  const out: Array<{ source: string; target: string }> = [];
  for (const e of edges) {
    const key = `${e.source}\0${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: e.source, target: e.target });
  }
  return out;
}

function assignRanks(
  nodes: FlowNode[],
  forward: Array<{ source: string; target: string }>,
): Map<string, number> {
  const succs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    succs.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of forward) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    succs.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const rank = new Map<string, number>();
  for (const n of nodes) rank.set(n.id, 0);
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    for (const v of succs.get(u) ?? []) {
      rank.set(v, Math.max(rank.get(v) ?? 0, (rank.get(u) ?? 0) + 1));
      const next = (indeg.get(v) ?? 1) - 1;
      indeg.set(v, next);
      if (next === 0) queue.push(v);
    }
  }
  return rank;
}

function orderRanks(
  graph: { nodes: FlowNode[]; edges: FlowEdge[] },
  forward: Array<{ source: string; target: string }>,
  rank: Map<string, number>,
): Map<number, string[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const n of graph.nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
  }
  for (const e of forward) {
    preds.get(e.target)?.push(e.source);
    succs.get(e.source)?.push(e.target);
  }

  const maxRank = Math.max(0, ...rank.values());
  const layers = new Map<number, string[]>();
  for (let r = 0; r <= maxRank; r++) layers.set(r, []);
  for (const n of graph.nodes) {
    layers.get(rank.get(n.id) ?? 0)!.push(n.id);
  }

  const branchIndex = (sourceId: string, targetId: string): number => {
    const source = byId.get(sourceId);
    if (!source) return 999;
    const branches = nodeBranches(source);
    let best = 999;
    for (const e of graph.edges) {
      if (e.source !== sourceId || e.target !== targetId) continue;
      const bid = branchIdForCondition(source, e.condition);
      const idx = bid === null ? -1 : branches.findIndex((b) => b.id === bid);
      if (idx >= 0 && idx < best) best = idx;
    }
    return best;
  };

  for (let r = 0; r <= maxRank; r++) {
    const ids = layers.get(r)!;
    ids.sort((a, b) => {
      const pa = preds.get(a) ?? [];
      const pb = preds.get(b) ?? [];
      const score = (id: string, parents: string[]) => {
        if (parents.length === 0) return TYPE_ORDER[byId.get(id)!.type] * 1_000_000;
        let best = Infinity;
        for (const p of parents) {
          const parentLayer = layers.get(rank.get(p) ?? 0) ?? [];
          const pIdx = parentLayer.indexOf(p);
          const s = (pIdx < 0 ? 0 : pIdx) * 1000 + branchIndex(p, id);
          if (s < best) best = s;
        }
        return best;
      };
      const d = score(a, pa) - score(b, pb);
      return d !== 0 ? d : a.localeCompare(b);
    });
  }

  const indexIn = (layer: string[], id: string) => {
    const i = layer.indexOf(id);
    return i < 0 ? 0 : i;
  };
  const bary = (id: string, neighbors: string[], neighborLayer: string[]): number | null => {
    const present = neighbors.filter((n) => neighborLayer.includes(n));
    if (present.length === 0) return null;
    return present.reduce((s, n) => s + indexIn(neighborLayer, n), 0) / present.length;
  };

  for (let iter = 0; iter < 4; iter++) {
    if (iter % 2 === 0) {
      for (let r = 1; r <= maxRank; r++) {
        const prev = layers.get(r - 1)!;
        const cur = layers.get(r)!;
        cur.sort((a, b) => {
          const ba = bary(a, preds.get(a) ?? [], prev);
          const bb = bary(b, preds.get(b) ?? [], prev);
          if (ba === null && bb === null) return 0;
          if (ba === null) return 1;
          if (bb === null) return -1;
          // Empate conserva a ordem dos ramos — localeCompare no desempate
          // reordenaria "hot/cold/else" por id e cruzaria o leque.
          return ba - bb;
        });
      }
    } else {
      for (let r = maxRank - 1; r >= 0; r--) {
        const next = layers.get(r + 1)!;
        const cur = layers.get(r)!;
        cur.sort((a, b) => {
          const ba = bary(a, succs.get(a) ?? [], next);
          const bb = bary(b, succs.get(b) ?? [], next);
          if (ba === null && bb === null) return 0;
          if (ba === null) return 1;
          if (bb === null) return -1;
          return ba - bb;
        });
      }
    }
  }

  return layers;
}
