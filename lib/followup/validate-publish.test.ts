import { describe, it, expect } from 'vitest';
import { validateFlowForPublish } from './validate-publish';
import type { FlowGraph, FlowNode, FlowEdge } from './graph-schema';

const pos = { x: 0, y: 0 };
const TEMPLATE_ID = '00000000-0000-4000-8000-000000000000';

function trigger(id: string): FlowNode {
  return { id, type: 'trigger', label: id, position: pos, config: {} };
}
function wait(id: string, config: Extract<FlowNode, { type: 'wait' }>['config']): FlowNode {
  return { id, type: 'wait', label: id, position: pos, config };
}
function condition(id: string): FlowNode {
  return {
    id,
    type: 'condition',
    label: id,
    position: pos,
    config: { combinator: 'and', checks: [{ field: 'steps_taken', op: 'gte', value: 0 }] },
  };
}
function classify(id: string, classes: string[], graceMs = 900_000): FlowNode {
  return {
    id,
    type: 'ai_classify',
    label: id,
    position: pos,
    config: { classes, grace_timeout_ms: graceMs, target: 'last_reply' },
  };
}
function actionTemplate(id: string, templateId = TEMPLATE_ID): FlowNode {
  return { id, type: 'action', label: id, position: pos, config: { mode: 'template', template_id: templateId } };
}
function actionAiMessage(id: string, opts: { fallback?: string } = {}): FlowNode {
  return {
    id,
    type: 'action',
    label: id,
    position: pos,
    config: { mode: 'ai_message', prompt_hint: 'hint', fallback_template_id: opts.fallback },
  };
}
function end(id: string, outcome: 'converted' | 'exhausted' | 'custom' = 'exhausted'): FlowNode {
  return { id, type: 'end', label: id, position: pos, config: { outcome } };
}

let edgeSeq = 0;
function edge(source: string, target: string, condition: FlowEdge['condition']): FlowEdge {
  edgeSeq++;
  return { id: `e${edgeSeq}`, source, target, priority: 0, condition };
}
const always = (): FlowEdge['condition'] => ({ type: 'always' });
const classMatch = (value: string): FlowEdge['condition'] => ({ type: 'class_match', value });
const condResult = (value: boolean): FlowEdge['condition'] => ({ type: 'cond_result', value });

function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { nodes, edges };
}

describe('validateFlowForPublish', () => {
  it('flags no_trigger when there is no trigger node', () => {
    const g = graph(
      [wait('w1', { mode: 'fixed', duration_ms: 300_000 }), end('e1')],
      [edge('w1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['no_trigger']);
      expect(result.errors[0]!.node_id).toBeNull();
    }
  });

  it('flags multiple_triggers for every trigger beyond the first', () => {
    const g = graph(
      [trigger('t1'), trigger('t2'), end('e1')],
      [edge('t1', 't2', always()), edge('t2', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['multiple_triggers']);
      expect(result.errors[0]!.node_id).toBe('t2');
    }
  });

  it('flags unreachable_node for nodes not reachable from the trigger', () => {
    const g = graph([trigger('t1'), end('e1'), end('orphan')], [edge('t1', 'e1', always())]);
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['unreachable_node']);
      expect(result.errors[0]!.node_id).toBe('orphan');
    }
  });

  it('flags no_end_path for reachable nodes that cannot reach an end', () => {
    const g = graph(
      [trigger('t1'), end('e1'), actionTemplate('deadend')],
      [edge('t1', 'e1', always()), edge('t1', 'deadend', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['no_end_path']);
      expect(result.errors[0]!.node_id).toBe('deadend');
    }
  });

  it('flags missing_class_edge when a declared class has no outgoing edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot', 'cold']), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'e1', classMatch('hot')),
        edge('c1', 'e1', classMatch('no_reply')),
        edge('c1', 'e1', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_class_edge']);
      expect(result.errors[0]!.node_id).toBe('c1');
    }
  });

  it('flags missing_no_reply_edge when there is no class_match "no_reply" edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot']), end('e1')],
      [edge('t1', 'c1', always()), edge('c1', 'e1', classMatch('hot')), edge('c1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_no_reply_edge']);
    }
  });

  it('flags missing_always_fallback when there is no always edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot']), end('e1')],
      [edge('t1', 'c1', always()), edge('c1', 'e1', classMatch('hot')), edge('c1', 'e1', classMatch('no_reply'))]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_always_fallback']);
    }
  });

  it('flags grace_too_short when grace_timeout_ms is below the 15min floor', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot'], 500_000), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'e1', classMatch('hot')),
        edge('c1', 'e1', classMatch('no_reply')),
        edge('c1', 'e1', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['grace_too_short']);
    }
  });

  it('flags long_wait_needs_template when accumulated wait reaches 24h before an ai_message action without fallback', () => {
    const g = graph(
      [trigger('t1'), wait('w1', { mode: 'fixed', duration_ms: 86_400_000 }), actionAiMessage('a1'), end('e1')],
      [edge('t1', 'w1', always()), edge('w1', 'a1', always()), edge('a1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['long_wait_needs_template']);
      expect(result.errors[0]!.node_id).toBe('a1');
    }
  });

  it('does not flag long_wait_needs_template when a fallback_template_id is set', () => {
    const g = graph(
      [
        trigger('t1'),
        wait('w1', { mode: 'fixed', duration_ms: 86_400_000 }),
        actionAiMessage('a1', { fallback: TEMPLATE_ID }),
        end('e1'),
      ],
      [edge('t1', 'w1', always()), edge('w1', 'a1', always()), edge('a1', 'e1', always())]
    );
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  it('flags cycle_without_wait for a cycle containing no sufficient wait node', () => {
    const g = graph(
      [trigger('t1'), condition('c1'), condition('c2'), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'c2', condResult(true)),
        edge('c2', 'c1', condResult(true)),
        edge('c1', 'e1', condResult(false)),
        edge('c2', 'e1', condResult(false)),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['cycle_without_wait']);
    }
  });

  it('does not flag cycle_without_wait when the cycle contains a sufficient wait node', () => {
    const g = graph(
      [trigger('t1'), condition('c1'), wait('w1', { mode: 'fixed', duration_ms: 300_000 }), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'w1', condResult(true)),
        edge('w1', 'c1', always()),
        edge('c1', 'e1', condResult(false)),
      ]
    );
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  // A regression fixture for the SCC-based cycle_without_wait check: A and B
  // form a cycle with no wait in it; C is a *separate* cycle with A that DOES
  // have a sufficient wait. A naive "does the whole component contain a wait"
  // check would merge A/B/C into one component (since C links back into A)
  // and wrongly conclude the component is safe. Removing sufficient-wait
  // nodes before computing SCCs (the actual algorithm) keeps A<->B a cycle on
  // its own and correctly flags it.
  it('flags cycle_without_wait when a wait-free cycle shares a node with a wait-guarded one', () => {
    const g = graph(
      [trigger('t1'), condition('A'), condition('B'), wait('C', { mode: 'fixed', duration_ms: 300_000 }), end('end1')],
      [
        edge('t1', 'A', always()),
        edge('A', 'B', condResult(true)),
        edge('B', 'A', condResult(true)),
        edge('A', 'C', condResult(false)),
        edge('C', 'A', always()),
        edge('B', 'end1', condResult(false)),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['cycle_without_wait']);
    }
  });

  it('does not flag max_steps_exceeded for a path of exactly 30 nodes', () => {
    const waitNodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let prev = 't1';
    for (let i = 1; i <= 28; i++) {
      const id = `w${i}`;
      waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
      edges.push(edge(prev, id, always()));
      prev = id;
    }
    edges.push(edge(prev, 'e1', always()));
    const g = graph([trigger('t1'), ...waitNodes, end('e1')], edges); // 1 + 28 + 1 = 30 nodes
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  it('flags max_steps_exceeded for a path of exactly 31 nodes', () => {
    const waitNodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let prev = 't1';
    for (let i = 1; i <= 29; i++) {
      const id = `w${i}`;
      waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
      edges.push(edge(prev, id, always()));
      prev = id;
    }
    edges.push(edge(prev, 'e1', always()));
    const g = graph([trigger('t1'), ...waitNodes, end('e1')], edges); // 1 + 29 + 1 = 31 nodes
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['max_steps_exceeded']);
    }
  });

  // Regression for the old per-path DFS: a width-2 "diamond" DAG re-converges
  // every layer, so the number of distinct trigger->leaf paths is 2^layers —
  // astronomically more than the old MAX_DFS_CALLS cap could enumerate for a
  // schema-legal 60-node graph, which silently truncated and could miss a
  // violation. The SCC-condensation sweep is O(V+E) regardless of path count,
  // so this must both finish fast and still catch the violator correctly.
  it('flags long_wait_needs_template in a wide reconverging DAG without blowing up', () => {
    // 27 wait layers + trigger + action + end = 30 steps exactly, so this
    // exercises long_wait_needs_template in isolation without also crossing
    // the (separately regression-tested) max_steps_exceeded boundary.
    const LAYERS = 27;
    const LAYER_WAIT_MS = 3_200_000; // 27 * 3.2M = 86.4M ms == 24h threshold
    const nodes: FlowNode[] = [trigger('t1')];
    const edges: FlowEdge[] = [];

    const layerId = (layer: number, branch: 'a' | 'b') => `d${layer}_${branch}`;

    for (let layer = 1; layer <= LAYERS; layer++) {
      nodes.push(wait(layerId(layer, 'a'), { mode: 'fixed', duration_ms: LAYER_WAIT_MS }));
      nodes.push(wait(layerId(layer, 'b'), { mode: 'fixed', duration_ms: LAYER_WAIT_MS }));

      const sources =
        layer === 1 ? (['t1', 't1'] as const) : ([layerId(layer - 1, 'a'), layerId(layer - 1, 'b')] as const);
      for (const source of sources) {
        edges.push(edge(source, layerId(layer, 'a'), always()));
        edges.push(edge(source, layerId(layer, 'b'), always()));
      }
    }

    nodes.push(actionAiMessage('act_bad')); // violator: no fallback_template_id
    nodes.push(actionTemplate('act_ok'));
    nodes.push(end('end_diamond'));
    for (const source of [layerId(LAYERS, 'a'), layerId(LAYERS, 'b')] as const) {
      edges.push(edge(source, 'act_bad', always()));
      edges.push(edge(source, 'act_ok', always()));
    }
    edges.push(edge('act_bad', 'end_diamond', always()));
    edges.push(edge('act_ok', 'end_diamond', always()));

    expect(nodes.length).toBe(58); // well within the schema's 60-node cap

    const start = performance.now();
    const result = validateFlowForPublish(graph(nodes, edges));
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1000); // polynomial, not exponential
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['long_wait_needs_template']);
      expect(result.errors[0]!.node_id).toBe('act_bad');
    }
  });

  it('passes a well-formed flow using all six node types', () => {
    const g = graph(
      [
        trigger('t1'),
        wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
        condition('cond1'),
        classify('cl1', ['hot', 'cold']),
        actionTemplate('a_hot'),
        actionAiMessage('a_cold', { fallback: TEMPLATE_ID }),
        end('end_won', 'converted'),
        end('end_lost', 'exhausted'),
      ],
      [
        edge('t1', 'w1', always()),
        edge('w1', 'cond1', always()),
        edge('cond1', 'cl1', condResult(true)),
        edge('cond1', 'end_lost', condResult(false)),
        edge('cl1', 'a_hot', classMatch('hot')),
        edge('cl1', 'a_cold', classMatch('cold')),
        edge('cl1', 'end_lost', classMatch('no_reply')),
        edge('cl1', 'end_lost', always()),
        edge('a_hot', 'end_won', always()),
        edge('a_cold', 'end_won', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(true);
  });
});
