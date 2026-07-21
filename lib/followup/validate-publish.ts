import type { FlowGraph, FlowEdge, FlowNode } from './graph-schema';

/**
 * Structural publish validator for follow-up flow graphs.
 * Checks are purely structural (reachability, coverage, cycles) — no DB access.
 */

export const PUBLISH_ERROR_CODES = [
  'no_trigger',
  'multiple_triggers',
  'unreachable_node',
  'no_end_path',
  'missing_class_edge',
  'missing_no_reply_edge',
  'missing_always_fallback',
  'grace_too_short',
  'long_wait_needs_template',
  'cycle_without_wait',
  'max_steps_exceeded',
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

export type PublishValidationError = {
  node_id: string | null;
  code: PublishErrorCode;
  message: string;
};

export type PublishValidationResult =
  | { ok: true }
  | { ok: false; errors: PublishValidationError[] };

const LONG_WAIT_THRESHOLD_MS = 86_400_000; // 24h
const MIN_CYCLE_WAIT_MS = 300_000; // 5min
const MAX_PATH_STEPS = 30;
// ponytail: caps worst-case path-DFS blowup on adversarial dense graphs; the
// schema already bounds graphs to 60 nodes / 120 edges so this cap is headroom,
// not a real limit for any graph a user can actually build in the editor.
const MAX_DFS_CALLS = 200_000;

function waitMs(config: Extract<FlowNode, { type: 'wait' }>['config']): number {
  return config.mode === 'fixed' ? config.duration_ms : config.max_ms;
}

function buildOutEdges(edges: FlowEdge[]): Map<string, FlowEdge[]> {
  const map = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge.source);
    if (list) list.push(edge);
    else map.set(edge.source, [edge]);
  }
  return map;
}

function bfsReachable(startIds: string[], outEdges: Map<string, FlowEdge[]>): Set<string> {
  const visited = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of outEdges.get(id) ?? []) {
      if (!visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return visited;
}

/** Tarjan strongly-connected-components, used to locate cycles. */
function stronglyConnectedComponents(
  nodeIds: string[],
  outEdges: Map<string, FlowEdge[]>
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const edge of outEdges.get(v) ?? []) {
      const w = edge.target;
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) strongconnect(id);
  }
  return components;
}

/**
 * Single per-path DFS from the trigger, tracking cumulative wait time
 * (fixed -> duration_ms, smart -> max_ms) and path length. A node already on
 * the current path is not re-entered (cycles count one iteration, per spec).
 */
function walkPaths(
  startId: string,
  nodesById: Map<string, FlowNode>,
  outEdges: Map<string, FlowEdge[]>
): { longWaitNodeIds: Set<string>; maxStepsExceeded: boolean } {
  const longWaitNodeIds = new Set<string>();
  let maxStepsExceeded = false;
  let calls = 0;

  function dfs(nodeId: string, accumulatedWait: number, pathVisited: Set<string>) {
    calls++;
    if (calls > MAX_DFS_CALLS) return;
    if (pathVisited.has(nodeId)) return;
    const node = nodesById.get(nodeId);
    if (!node) return; // dangling edge reference — not this validator's concern

    const nextVisited = new Set(pathVisited);
    nextVisited.add(nodeId);
    if (nextVisited.size > MAX_PATH_STEPS) maxStepsExceeded = true;

    const nextAccumulated = node.type === 'wait' ? accumulatedWait + waitMs(node.config) : accumulatedWait;

    if (
      node.type === 'action' &&
      node.config.mode === 'ai_message' &&
      !node.config.fallback_template_id &&
      nextAccumulated >= LONG_WAIT_THRESHOLD_MS
    ) {
      longWaitNodeIds.add(nodeId);
    }

    for (const edge of outEdges.get(nodeId) ?? []) {
      dfs(edge.target, nextAccumulated, nextVisited);
    }
  }

  dfs(startId, 0, new Set());
  return { longWaitNodeIds, maxStepsExceeded };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

export function validateFlowForPublish(graph: FlowGraph): PublishValidationResult {
  const { nodes, edges } = graph;
  const errors: PublishValidationError[] = [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = buildOutEdges(edges);
  const inEdges = buildOutEdges(edges.map((e) => ({ ...e, source: e.target, target: e.source })));

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) {
    errors.push({
      node_id: null,
      code: 'no_trigger',
      message: 'O fluxo precisa de exatamente um nó trigger.',
    });
  }
  if (triggers.length > 1) {
    for (const extra of triggers.slice(1)) {
      errors.push({
        node_id: extra.id,
        code: 'multiple_triggers',
        message: `Nó trigger duplicado: "${extra.id}".`,
      });
    }
  }

  const startTrigger = triggers[0];
  if (startTrigger) {
    const reachable = bfsReachable([startTrigger.id], outEdges);
    for (const node of [...nodes].sort(byId)) {
      if (!reachable.has(node.id)) {
        errors.push({
          node_id: node.id,
          code: 'unreachable_node',
          message: `Nó "${node.id}" não é alcançável a partir do trigger.`,
        });
      }
    }

    const endNodes = nodes.filter((n) => n.type === 'end');
    const canReachEnd = bfsReachable(endNodes.map((n) => n.id), inEdges);
    for (const node of [...nodes].sort(byId)) {
      if (reachable.has(node.id) && !canReachEnd.has(node.id)) {
        errors.push({
          node_id: node.id,
          code: 'no_end_path',
          message: `Nó "${node.id}" não tem caminho até um nó de fim.`,
        });
      }
    }

    const { longWaitNodeIds, maxStepsExceeded } = walkPaths(startTrigger.id, nodesById, outEdges);
    for (const id of [...longWaitNodeIds].sort()) {
      errors.push({
        node_id: id,
        code: 'long_wait_needs_template',
        message: `Nó "${id}" acumula ≥24h de espera e precisa de fallback_template_id.`,
      });
    }
    if (maxStepsExceeded) {
      errors.push({
        node_id: null,
        code: 'max_steps_exceeded',
        message: `O caminho mais longo a partir do trigger excede ${MAX_PATH_STEPS} passos.`,
      });
    }
  }

  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'ai_classify') continue;
    const outgoing = outEdges.get(node.id) ?? [];

    for (const cls of node.config.classes) {
      const hasEdge = outgoing.some(
        (e) => e.condition.type === 'class_match' && e.condition.value === cls
      );
      if (!hasEdge) {
        errors.push({
          node_id: node.id,
          code: 'missing_class_edge',
          message: `Nó "${node.id}" não tem edge class_match para a classe "${cls}".`,
        });
      }
    }

    const hasNoReply = outgoing.some(
      (e) => e.condition.type === 'class_match' && e.condition.value === 'no_reply'
    );
    if (!hasNoReply) {
      errors.push({
        node_id: node.id,
        code: 'missing_no_reply_edge',
        message: `Nó "${node.id}" não tem edge class_match para "no_reply".`,
      });
    }

    const hasAlways = outgoing.some((e) => e.condition.type === 'always');
    if (!hasAlways) {
      errors.push({
        node_id: node.id,
        code: 'missing_always_fallback',
        message: `Nó "${node.id}" não tem edge "always" de fallback.`,
      });
    }

    if (node.config.grace_timeout_ms < 900_000) {
      errors.push({
        node_id: node.id,
        code: 'grace_too_short',
        message: `Nó "${node.id}" tem grace_timeout_ms abaixo do mínimo de 15min.`,
      });
    }
  }

  // ponytail: SCC-based over-approximation. A cycle is flagged only when NO
  // node in its whole strongly-connected component is a sufficient wait node —
  // exact for "no wait anywhere in the loop", but a component with a safe wait
  // node reachable only by SOME of its cycles won't distinguish between them.
  // Upgrade to per-simple-cycle checking if that gap ever bites in practice.
  const components = stronglyConnectedComponents(
    nodes.map((n) => n.id),
    outEdges
  );
  for (const component of components) {
    const firstId = component[0]!; // Tarjan never yields an empty component
    const isCycle =
      component.length > 1 || (outEdges.get(firstId) ?? []).some((e) => e.target === firstId);
    if (!isCycle) continue;

    const hasSufficientWait = component.some((id) => {
      const node = nodesById.get(id);
      if (!node || node.type !== 'wait') return false;
      return node.config.mode === 'fixed'
        ? node.config.duration_ms >= MIN_CYCLE_WAIT_MS
        : node.config.min_ms >= MIN_CYCLE_WAIT_MS;
    });

    if (!hasSufficientWait) {
      const nodeId = [...component].sort()[0]!; // same non-empty guarantee as above
      errors.push({
        node_id: nodeId,
        code: 'cycle_without_wait',
        message: `Ciclo sem espera mínima de 5min detectado (contém "${nodeId}").`,
      });
    }
  }

  if (errors.length === 0) return { ok: true };

  errors.sort((a, b) => {
    const rankDiff = PUBLISH_ERROR_CODES.indexOf(a.code) - PUBLISH_ERROR_CODES.indexOf(b.code);
    if (rankDiff !== 0) return rankDiff;
    return (a.node_id ?? '').localeCompare(b.node_id ?? '');
  });

  return { ok: false, errors };
}
