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

function waitMs(config: Extract<FlowNode, { type: 'wait' }>['config']): number {
  return config.mode === 'fixed' ? config.duration_ms : config.max_ms;
}

/** A wait node whose duration meets the 5min floor required to break a cycle. */
function isSufficientWaitNode(node: FlowNode): boolean {
  if (node.type !== 'wait') return false;
  return node.config.mode === 'fixed'
    ? node.config.duration_ms >= MIN_CYCLE_WAIT_MS
    : node.config.min_ms >= MIN_CYCLE_WAIT_MS;
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

/**
 * Tarjan strongly-connected-components. Returned components are in the
 * algorithm's natural finishing order, which is the REVERSE of a topological
 * order of the condensation DAG (a component finishes only after every
 * component reachable from it has already finished). Callers that need a
 * source-to-sink sweep should iterate the result back-to-front.
 */
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
 * Whether a component (as returned by stronglyConnectedComponents) is an
 * actual cycle in `outEdges`: more than one node, or a single node with a
 * self-loop.
 */
function isCycleComponent(component: string[], outEdges: Map<string, FlowEdge[]>): boolean {
  if (component.length > 1) return true;
  const onlyId = component[0]!; // Tarjan never yields an empty component
  return (outEdges.get(onlyId) ?? []).some((e) => e.target === onlyId);
}

/**
 * SCC condensation + topological forward sweep from the trigger, computing —
 * per component reachable from it — the MAX accumulated wait (fixed ->
 * duration_ms, smart -> max_ms) and MAX accumulated step count over any path
 * from the trigger. A component's own internal wait/step total is counted
 * once no matter how many original-graph cycles loop inside it (implements
 * "cycles count 1 iteration"). Polynomial (O(V+E)): no per-path enumeration,
 * so branching/reconverging DAGs can't blow it up.
 *
 * ponytail: dentro de um SCC multi-ramo o total soma TODOS os waits/nós do
 * componente — upper bound conservador (nunca aceita grafo ruim; pode gerar
 * 422 a mais num SCC com sub-loops independentes). Máximo exato por caminho
 * simples é NP-difícil; upgrade só se 422 falso-positivo aparecer na prática.
 */
function analyzeCondensedPaths(
  startId: string,
  nodes: FlowNode[],
  nodesById: Map<string, FlowNode>,
  outEdges: Map<string, FlowEdge[]>
): { longWaitNodeIds: Set<string>; maxStepsExceeded: boolean } {
  const longWaitNodeIds = new Set<string>();
  let maxStepsExceeded = false;

  const components = stronglyConnectedComponents(
    nodes.map((n) => n.id),
    outEdges
  );
  const componentIndexById = new Map<string, number>();
  components.forEach((comp, idx) => comp.forEach((id) => componentIndexById.set(id, idx)));

  const waitWeight = components.map((comp) =>
    comp.reduce((sum, id) => {
      const node = nodesById.get(id);
      return node && node.type === 'wait' ? sum + waitMs(node.config) : sum;
    }, 0)
  );
  const stepWeight = components.map((comp) => comp.length);

  const condOut = new Map<number, Set<number>>();
  for (const edgeList of outEdges.values()) {
    for (const edge of edgeList) {
      const cu = componentIndexById.get(edge.source);
      const cv = componentIndexById.get(edge.target);
      if (cu === undefined || cv === undefined || cu === cv) continue;
      const succs = condOut.get(cu);
      if (succs) succs.add(cv);
      else condOut.set(cu, new Set([cv]));
    }
  }

  const startComp = componentIndexById.get(startId);
  if (startComp === undefined) return { longWaitNodeIds, maxStepsExceeded };

  const arriveWait = new Map<number, number>([[startComp, 0]]);
  const arriveSteps = new Map<number, number>([[startComp, 0]]);

  // components[] is in reverse-topological (Tarjan finishing) order; walking
  // it back-to-front visits every predecessor component before its successors.
  for (let idx = components.length - 1; idx >= 0; idx--) {
    const arrivedWait = arriveWait.get(idx);
    if (arrivedWait === undefined) continue; // not reachable from the trigger
    const arrivedSteps = arriveSteps.get(idx)!;

    const totalWait = arrivedWait + waitWeight[idx]!;
    const totalSteps = arrivedSteps + stepWeight[idx]!;

    if (totalSteps > MAX_PATH_STEPS) maxStepsExceeded = true;

    for (const id of components[idx]!) {
      const node = nodesById.get(id);
      if (
        node &&
        node.type === 'action' &&
        node.config.mode === 'ai_message' &&
        !node.config.fallback_template_id &&
        totalWait >= LONG_WAIT_THRESHOLD_MS
      ) {
        longWaitNodeIds.add(id);
      }
    }

    for (const succ of condOut.get(idx) ?? []) {
      arriveWait.set(succ, Math.max(arriveWait.get(succ) ?? -Infinity, totalWait));
      arriveSteps.set(succ, Math.max(arriveSteps.get(succ) ?? -Infinity, totalSteps));
    }
  }

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

    const { longWaitNodeIds, maxStepsExceeded } = analyzeCondensedPaths(
      startTrigger.id,
      nodes,
      nodesById,
      outEdges
    );
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

  // cycle_without_wait — exact, not an approximation: a directed cycle with no
  // sufficient-wait node exists IFF removing every sufficient-wait node still
  // leaves a cycle (SCC with >1 node, or a self-loop) in the remaining
  // subgraph. Runs independently of trigger reachability — a node can carry
  // both unreachable_node and cycle_without_wait at once; that's intentional,
  // each signal is independently actionable for the editor UI.
  const sufficientWaitIds = new Set(nodes.filter(isSufficientWaitNode).map((n) => n.id));
  const remainingIds = nodes.map((n) => n.id).filter((id) => !sufficientWaitIds.has(id));
  const remainingEdges = edges.filter(
    (e) => !sufficientWaitIds.has(e.source) && !sufficientWaitIds.has(e.target)
  );
  const remainingOutEdges = buildOutEdges(remainingEdges);
  const cycleComponents = stronglyConnectedComponents(remainingIds, remainingOutEdges);
  for (const component of cycleComponents) {
    if (!isCycleComponent(component, remainingOutEdges)) continue;
    const nodeId = [...component].sort()[0]!;
    errors.push({
      node_id: nodeId,
      code: 'cycle_without_wait',
      message: `Ciclo sem espera mínima de 5min detectado (contém "${nodeId}").`,
    });
  }

  if (errors.length === 0) return { ok: true };

  errors.sort((a, b) => {
    const rankDiff = PUBLISH_ERROR_CODES.indexOf(a.code) - PUBLISH_ERROR_CODES.indexOf(b.code);
    if (rankDiff !== 0) return rankDiff;
    return (a.node_id ?? '').localeCompare(b.node_id ?? '');
  });

  return { ok: false, errors };
}
