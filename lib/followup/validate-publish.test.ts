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

  it('flags max_steps_exceeded when the longest acyclic path from trigger exceeds 30 nodes', () => {
    const waitNodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    let prev = 't1';
    for (let i = 1; i <= 31; i++) {
      const id = `w${i}`;
      waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
      edges.push(edge(prev, id, always()));
      prev = id;
    }
    edges.push(edge(prev, 'e1', always()));
    const g = graph([trigger('t1'), ...waitNodes, end('e1')], edges);
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain('max_steps_exceeded');
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
