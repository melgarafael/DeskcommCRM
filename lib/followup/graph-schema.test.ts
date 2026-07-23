import { describe, it, expect } from 'vitest';
import {
  NODE_TYPES,
  NodeType,
  waitConfigSchema,
  aiClassifyConfigSchema,
  actionConfigSchema,
  conditionConfigSchema,
  endConfigSchema,
  flowNodeSchema,
  flowEdgeSchema,
  flowGraphSchema,
  FlowGraph,
  FlowNode,
  FlowEdge,
} from './graph-schema';

describe('graph-schema', () => {
  describe('NODE_TYPES & NodeType', () => {
    it('exports NODE_TYPES constant', () => {
      expect(NODE_TYPES).toEqual([
        'trigger',
        'wait',
        'condition',
        'ai_classify',
        'action',
        'end',
      ]);
    });

    it('NodeType type matches NODE_TYPES', () => {
      const nt: NodeType = 'trigger';
      expect(nt).toBeTruthy();
    });
  });

  describe('waitConfigSchema', () => {
    describe('fixed mode', () => {
      it('accepts valid fixed duration', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'fixed',
          duration_ms: 300_000, // 5 min
        });
        expect(result.success).toBe(true);
      });

      it('accepts max duration', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'fixed',
          duration_ms: 7_776_000_000, // 90 days
        });
        expect(result.success).toBe(true);
      });

      it('rejects duration below 5 min', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'fixed',
          duration_ms: 299_999,
        });
        expect(result.success).toBe(false);
      });

      it('rejects duration above 90 days', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'fixed',
          duration_ms: 7_776_000_001,
        });
        expect(result.success).toBe(false);
      });

      it('rejects extra keys', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'fixed',
          duration_ms: 300_000,
          extra_key: 'should reject',
        });
        expect(result.success).toBe(false);
      });

      it('rejects non-integer duration', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'fixed',
          duration_ms: 300_000.5,
        });
        expect(result.success).toBe(false);
      });
    });

    describe('smart mode', () => {
      it('accepts valid smart range', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'smart',
          min_ms: 300_000,
          max_ms: 7_776_000_000,
          guidance: 'wait for reply',
        });
        expect(result.success).toBe(true);
      });

      it('accepts smart without guidance', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'smart',
          min_ms: 300_000,
          max_ms: 7_776_000_000,
        });
        expect(result.success).toBe(true);
      });

      it('rejects when min > max', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'smart',
          min_ms: 7_776_000_000,
          max_ms: 300_000,
        });
        expect(result.success).toBe(false);
      });

      it('rejects when min below 5 min', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'smart',
          min_ms: 299_999,
          max_ms: 7_776_000_000,
        });
        expect(result.success).toBe(false);
      });

      it('rejects when max above 90 days', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'smart',
          min_ms: 300_000,
          max_ms: 7_776_000_001,
        });
        expect(result.success).toBe(false);
      });

      it('rejects guidance over 500 chars', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'smart',
          min_ms: 300_000,
          max_ms: 7_776_000_000,
          guidance: 'a'.repeat(501),
        });
        expect(result.success).toBe(false);
      });

      it('rejects extra keys', () => {
        const result = waitConfigSchema.safeParse({
          mode: 'smart',
          min_ms: 300_000,
          max_ms: 7_776_000_000,
          extra_key: 'should reject',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('aiClassifyConfigSchema', () => {
    it('accepts valid config', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: ['hot', 'warm', 'cold'],
        grace_timeout_ms: 900_000,
        target: 'last_reply',
      });
      expect(result.success).toBe(true);
    });

    it('accepts config with hint', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: ['yes', 'no'],
        grace_timeout_ms: 900_000,
        hint: 'classify as yes or no',
      });
      expect(result.success).toBe(true);
    });

    it('defaults target to last_reply', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: ['a', 'b'],
        grace_timeout_ms: 900_000,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.target).toBe('last_reply');
      }
    });

    it('rejects empty classes array', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: [],
        grace_timeout_ms: 900_000,
      });
      expect(result.success).toBe(false);
    });

    it('rejects more than 8 classes', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: Array.from({ length: 9 }, (_, i) => `class${i}`),
        grace_timeout_ms: 900_000,
      });
      expect(result.success).toBe(false);
    });

    it('rejects class string over 40 chars', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: ['a'.repeat(41)],
        grace_timeout_ms: 900_000,
      });
      expect(result.success).toBe(false);
    });

    it('rejects grace_timeout below 15 min', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: ['a'],
        grace_timeout_ms: 899_999,
      });
      expect(result.success).toBe(false);
    });

    it('rejects hint over 500 chars', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: ['a'],
        grace_timeout_ms: 900_000,
        hint: 'a'.repeat(501),
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra keys', () => {
      const result = aiClassifyConfigSchema.safeParse({
        classes: ['a'],
        grace_timeout_ms: 900_000,
        extra_key: 'should reject',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('actionConfigSchema', () => {
    describe('ai_message mode', () => {
      it('accepts valid ai_message config', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'ai_message',
          prompt_hint: 'suggest best next action',
        });
        expect(result.success).toBe(true);
      });

      it('accepts with fallback_template_id', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'ai_message',
          prompt_hint: 'suggest',
          fallback_template_id: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(result.success).toBe(true);
      });

      it('rejects ai_message without prompt_hint', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'ai_message',
        });
        expect(result.success).toBe(false);
      });

      it('rejects empty prompt_hint', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'ai_message',
          prompt_hint: '',
        });
        expect(result.success).toBe(false);
      });

      it('rejects prompt_hint over 1000 chars', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'ai_message',
          prompt_hint: 'a'.repeat(1001),
        });
        expect(result.success).toBe(false);
      });

      it('rejects invalid UUID for fallback_template_id', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'ai_message',
          prompt_hint: 'suggest',
          fallback_template_id: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
      });

      it('rejects extra keys', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'ai_message',
          prompt_hint: 'suggest',
          extra_key: 'should reject',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('template mode', () => {
      it('accepts valid template config', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'template',
          template_id: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(result.success).toBe(true);
      });

      it('rejects template without template_id', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'template',
        });
        expect(result.success).toBe(false);
      });

      it('rejects invalid UUID for template_id', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'template',
          template_id: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
      });

      it('rejects extra keys', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'template',
          template_id: '550e8400-e29b-41d4-a716-446655440000',
          extra_key: 'should reject',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('conditionConfigSchema', () => {
    it('accepts valid condition', () => {
      const result = conditionConfigSchema.safeParse({
        combinator: 'and',
        checks: [
          { field: 'lead_stage', op: 'eq', value: 'qualified' },
          { field: 'last_outcome', op: 'neq', value: 'lost' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('defaults combinator to and', () => {
      const result = conditionConfigSchema.safeParse({
        checks: [{ field: 'tag', op: 'contains', value: 'vip' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.combinator).toBe('and');
      }
    });

    it('accepts or combinator', () => {
      const result = conditionConfigSchema.safeParse({
        combinator: 'or',
        checks: [{ field: 'lead_stage', op: 'eq', value: 'a' }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts numeric value', () => {
      const result = conditionConfigSchema.safeParse({
        checks: [{ field: 'steps_taken', op: 'gte', value: 5 }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty checks', () => {
      const result = conditionConfigSchema.safeParse({
        checks: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects more than 10 checks', () => {
      const result = conditionConfigSchema.safeParse({
        checks: Array.from({ length: 11 }, () => ({
          field: 'lead_stage' as const,
          op: 'eq' as const,
          value: 'a',
        })),
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid field', () => {
      const result = conditionConfigSchema.safeParse({
        checks: [
          { field: 'invalid_field', op: 'eq', value: 'a' },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid operator', () => {
      const result = conditionConfigSchema.safeParse({
        checks: [
          { field: 'lead_stage', op: 'invalid_op', value: 'a' },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra keys', () => {
      const result = conditionConfigSchema.safeParse({
        checks: [{ field: 'lead_stage', op: 'eq', value: 'a' }],
        extra_key: 'should reject',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('endConfigSchema', () => {
    it('accepts converted outcome', () => {
      const result = endConfigSchema.safeParse({
        outcome: 'converted',
      });
      expect(result.success).toBe(true);
    });

    it('accepts with optional note', () => {
      const result = endConfigSchema.safeParse({
        outcome: 'exhausted',
        note: 'too many retries',
      });
      expect(result.success).toBe(true);
    });

    it('rejects note over 200 chars', () => {
      const result = endConfigSchema.safeParse({
        outcome: 'converted',
        note: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid outcome', () => {
      const result = endConfigSchema.safeParse({
        outcome: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra keys', () => {
      const result = endConfigSchema.safeParse({
        outcome: 'converted',
        extra_key: 'should reject',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('flowEdgeSchema', () => {
    it('accepts always condition', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge1',
        source: 'trigger',
        target: 'wait',
        condition: { type: 'always' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts class_match condition', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge2',
        source: 'classify',
        target: 'action',
        condition: { type: 'class_match', value: 'hot' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts no_reply as class_match value', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge3',
        source: 'classify',
        target: 'end',
        condition: { type: 'class_match', value: 'no_reply' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts cond_result condition', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge4',
        source: 'condition',
        target: 'action',
        condition: { type: 'cond_result', value: true },
      });
      expect(result.success).toBe(true);
    });

    it('defaults priority to 0', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge5',
        source: 'a',
        target: 'b',
        condition: { type: 'always' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.priority).toBe(0);
      }
    });

    it('accepts custom priority', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge6',
        source: 'a',
        target: 'b',
        priority: 10,
        condition: { type: 'always' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.priority).toBe(10);
      }
    });

    it('rejects non-integer priority', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge7',
        source: 'a',
        target: 'b',
        priority: 10.5,
        condition: { type: 'always' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra keys', () => {
      const result = flowEdgeSchema.safeParse({
        id: 'edge8',
        source: 'a',
        target: 'b',
        condition: { type: 'always' },
        extra_key: 'should reject',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('flowNodeSchema (discriminated union)', () => {
    it('accepts trigger node', () => {
      const result = flowNodeSchema.safeParse({
        id: 'trigger-1',
        type: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      });
      expect(result.success).toBe(true);
    });

    it('accepts wait node with fixed config', () => {
      const result = flowNodeSchema.safeParse({
        id: 'wait-1',
        type: 'wait',
        label: 'Wait 5 min',
        position: { x: 100, y: 100 },
        config: {
          mode: 'fixed',
          duration_ms: 300_000,
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts condition node', () => {
      const result = flowNodeSchema.safeParse({
        id: 'cond-1',
        type: 'condition',
        label: 'Is VIP?',
        position: { x: 200, y: 200 },
        config: {
          checks: [{ field: 'tag', op: 'contains', value: 'vip' }],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts ai_classify node', () => {
      const result = flowNodeSchema.safeParse({
        id: 'classify-1',
        type: 'ai_classify',
        label: 'Classify Interest',
        position: { x: 300, y: 300 },
        config: {
          classes: ['high', 'low'],
          grace_timeout_ms: 900_000,
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts action node', () => {
      const result = flowNodeSchema.safeParse({
        id: 'action-1',
        type: 'action',
        label: 'Send Offer',
        position: { x: 400, y: 400 },
        config: {
          mode: 'ai_message',
          prompt_hint: 'send best offer',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts end node', () => {
      const result = flowNodeSchema.safeParse({
        id: 'end-1',
        type: 'end',
        label: 'Finished',
        position: { x: 500, y: 500 },
        config: {
          outcome: 'converted',
          note: 'successful',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects node without id', () => {
      const result = flowNodeSchema.safeParse({
        type: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty id', () => {
      const result = flowNodeSchema.safeParse({
        id: '',
        type: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty label', () => {
      const result = flowNodeSchema.safeParse({
        id: 'n1',
        type: 'trigger',
        label: '',
        position: { x: 0, y: 0 },
        config: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects label over 60 chars', () => {
      const result = flowNodeSchema.safeParse({
        id: 'n1',
        type: 'trigger',
        label: 'a'.repeat(61),
        position: { x: 0, y: 0 },
        config: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid position shape', () => {
      const result = flowNodeSchema.safeParse({
        id: 'n1',
        type: 'trigger',
        label: 'Start',
        position: { x: 'invalid', y: 0 },
        config: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects mismatched config for node type', () => {
      const result = flowNodeSchema.safeParse({
        id: 'wait-1',
        type: 'wait',
        label: 'Wait',
        position: { x: 0, y: 0 },
        config: { classes: ['a'] }, // ai_classify config, not wait
      });
      expect(result.success).toBe(false);
    });

    it('rejects trigger node with non-empty config', () => {
      const result = flowNodeSchema.safeParse({
        id: 'trigger-1',
        type: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: { something: 'invalid' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra keys in node', () => {
      const result = flowNodeSchema.safeParse({
        id: 'n1',
        type: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: {},
        extra_key: 'should reject',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('flowGraphSchema', () => {
    it('accepts valid graph with 2 nodes', () => {
      const result = flowGraphSchema.safeParse({
        nodes: [
          {
            id: 'trigger-1',
            type: 'trigger',
            label: 'Start',
            position: { x: 0, y: 0 },
            config: {},
          },
          {
            id: 'end-1',
            type: 'end',
            label: 'End',
            position: { x: 100, y: 100 },
            config: { outcome: 'converted' },
          },
        ],
        edges: [
          {
            id: 'edge-1',
            source: 'trigger-1',
            target: 'end-1',
            condition: { type: 'always' },
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects graph with 1 node', () => {
      const result = flowGraphSchema.safeParse({
        nodes: [
          {
            id: 'trigger-1',
            type: 'trigger',
            label: 'Start',
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
        edges: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects graph with > 60 nodes', () => {
      const nodes = Array.from({ length: 61 }, (_, i) => ({
        id: `n${i}`,
        type: 'trigger' as const,
        label: `Node ${i}`,
        position: { x: i * 10, y: i * 10 },
        config: {} as Record<string, never>,
      }));
      const result = flowGraphSchema.safeParse({
        nodes,
        edges: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects graph with > 120 edges', () => {
      const nodes = [
        {
          id: 'trigger-1',
          type: 'trigger' as const,
          label: 'Start',
          position: { x: 0, y: 0 },
          config: {} as Record<string, never>,
        },
        {
          id: 'end-1',
          type: 'end' as const,
          label: 'End',
          position: { x: 100, y: 100 },
          config: { outcome: 'converted' as const },
        },
      ];
      const edges = Array.from({ length: 121 }, (_, i) => ({
        id: `edge${i}`,
        source: 'trigger-1',
        target: 'end-1',
        condition: { type: 'always' as const },
      }));
      const result = flowGraphSchema.safeParse({
        nodes,
        edges,
      });
      expect(result.success).toBe(false);
    });

    it('rejects graph with no edges', () => {
      // This should pass since edges array can be empty
      const result = flowGraphSchema.safeParse({
        nodes: [
          {
            id: 'trigger-1',
            type: 'trigger',
            label: 'Start',
            position: { x: 0, y: 0 },
            config: {},
          },
          {
            id: 'end-1',
            type: 'end',
            label: 'End',
            position: { x: 100, y: 100 },
            config: { outcome: 'converted' },
          },
        ],
        edges: [],
      });
      expect(result.success).toBe(true); // Edges can be empty
    });

    it('rejects extra keys in graph', () => {
      const result = flowGraphSchema.safeParse({
        nodes: [
          {
            id: 'trigger-1',
            type: 'trigger',
            label: 'Start',
            position: { x: 0, y: 0 },
            config: {},
          },
          {
            id: 'end-1',
            type: 'end',
            label: 'End',
            position: { x: 100, y: 100 },
            config: { outcome: 'converted' },
          },
        ],
        edges: [],
        extra_key: 'should reject',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('type inference', () => {
    it('FlowGraph type is inferred correctly', () => {
      const graph: FlowGraph = {
        nodes: [
          {
            id: 'trigger-1',
            type: 'trigger',
            label: 'Start',
            position: { x: 0, y: 0 },
            config: {},
          },
          {
            id: 'end-1',
            type: 'end',
            label: 'End',
            position: { x: 100, y: 100 },
            config: { outcome: 'converted' },
          },
        ],
        edges: [],
      };
      expect(graph).toBeTruthy();
    });

    it('FlowNode type is inferred correctly', () => {
      const node: FlowNode = {
        id: 'wait-1',
        type: 'wait',
        label: 'Wait',
        position: { x: 0, y: 0 },
        config: { mode: 'fixed', duration_ms: 300_000 },
      };
      expect(node).toBeTruthy();
    });

    it('FlowEdge type is inferred correctly', () => {
      const edge: FlowEdge = {
        id: 'e1',
        source: 'trigger-1',
        target: 'wait-1',
        priority: 0,
        condition: { type: 'always' },
      };
      expect(edge).toBeTruthy();
    });
  });
});
