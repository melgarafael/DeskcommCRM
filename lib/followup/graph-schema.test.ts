import { describe, it, expect } from 'vitest';
import {
  NODE_TYPES,
  waitConfigSchema,
  aiClassifyConfigSchema,
  matchReplyConfigSchema,
  actionConfigSchema,
  conditionConfigSchema,
  endConfigSchema,
  flowNodeSchema,
  flowEdgeSchema,
  flowGraphSchema,
  FALLBACK_BRANCH_ID,
  NO_REPLY_BRANCH_ID,
  CONDITION_TRUE_BRANCH_ID,
  CONDITION_FALSE_BRANCH_ID,
  RESERVED_BRANCH_IDS,
  nodeBranches,
  branchIdForCondition,
  conditionForBranch,
} from './graph-schema';
import type { NodeType, FlowGraph, FlowNode, FlowEdge } from './graph-schema';
import { toReactFlow, fromReactFlow } from './graph-mappers';

describe('graph-schema', () => {
  describe('NODE_TYPES & NodeType', () => {
    it('exports NODE_TYPES constant', () => {
      expect(NODE_TYPES).toEqual([
        'trigger',
        'wait',
        'condition',
        'ai_classify',
        'match_reply',
        'repeat',
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
    describe('text mode', () => {
      it('accepts a fixed body', () => {
        const result = actionConfigSchema.safeParse({
          mode: 'text',
          body: 'Olá, qual é o seu nome?',
        });
        expect(result.success).toBe(true);
      });

      it('rejects empty body', () => {
        const result = actionConfigSchema.safeParse({ mode: 'text', body: '' });
        expect(result.success).toBe(false);
      });
    });

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

    it('accepts match_reply with save_to and if_exists', () => {
      const result = matchReplyConfigSchema.safeParse({
        branches: [{ id: 'br_sim', label: 'Sim', op: 'contains', pattern: 'sim' }],
        grace_timeout_ms: 900_000,
        save_to: { kind: 'lead_custom', key: 'endereco' },
        if_exists: 'confirm',
      });
      expect(result.success).toBe(true);
    });

    it('accepts match_reply node', () => {
      const result = flowNodeSchema.safeParse({
        id: 'mr-1',
        type: 'match_reply',
        label: 'Casar texto',
        position: { x: 300, y: 300 },
        config: {
          branches: [{ id: 'br_sim', label: 'Sim', op: 'contains', pattern: 'sim' }],
          grace_timeout_ms: 900_000,
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects match_reply with grace below 15min', () => {
      const result = flowNodeSchema.safeParse({
        id: 'mr-1',
        type: 'match_reply',
        label: 'Casar texto',
        position: { x: 0, y: 0 },
        config: {
          branches: [{ id: 'br_sim', label: 'Sim', op: 'eq', pattern: 'ok' }],
          grace_timeout_ms: 899_999,
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects match_reply reserved branch id and unknown op', () => {
      expect(
        matchReplyConfigSchema.safeParse({
          branches: [{ id: 'no_reply', label: 'X', op: 'contains', pattern: 'x' }],
          grace_timeout_ms: 900_000,
        }).success,
      ).toBe(false);
      expect(
        matchReplyConfigSchema.safeParse({
          branches: [{ id: 'br_a', label: 'A', op: 'regex', pattern: 'x' }],
          grace_timeout_ms: 900_000,
        }).success,
      ).toBe(false);
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

    /**
     * Integridade ENTRE nós e arestas (#699). Cada peça passava no schema
     * sozinha — quem montava o grafo (o canvas, ao excluir um nó) produzia
     * aresta órfã e ids repetidos que só quebravam longe do defeito. Aqui o
     * contrato é de fora: rejeitar com o id a corrigir na mensagem.
     */
    describe('integridade: aresta órfã e ids repetidos (#699)', () => {
      const noTrigger = (id: string) => ({
        id,
        type: 'trigger' as const,
        label: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      });
      const noEnd = (id: string) => ({
        id,
        type: 'end' as const,
        label: 'End',
        position: { x: 100, y: 100 },
        config: { outcome: 'converted' as const },
      });
      const aresta = (id: string, source: string, target: string) => ({
        id,
        source,
        target,
        condition: { type: 'always' as const },
      });

      /** [] quando o grafo passou — a asserção de mensagem falha em vez de pular. */
      function mensagensDe(resultado: ReturnType<typeof flowGraphSchema.safeParse>): string[] {
        return resultado.success ? [] : resultado.error.issues.map((i) => i.message);
      }

      it('aceita grafo íntegro com aresta ligando dois nós existentes (controle)', () => {
        const result = flowGraphSchema.safeParse({
          nodes: [noTrigger('no-1'), noEnd('no-2')],
          edges: [aresta('e-1', 'no-1', 'no-2')],
        });
        expect(result.success).toBe(true);
      });

      it('rejeita aresta cujo source aponta para nó inexistente', () => {
        const result = flowGraphSchema.safeParse({
          nodes: [noTrigger('no-1'), noEnd('no-2')],
          edges: [aresta('e-3', 'no-9', 'no-2')],
        });
        expect(result.success).toBe(false);
        expect(mensagensDe(result)).toContain('aresta "e-3" aponta para nó inexistente: "no-9"');
      });

      it('rejeita aresta cujo target aponta para nó inexistente', () => {
        const result = flowGraphSchema.safeParse({
          nodes: [noTrigger('no-1'), noEnd('no-2')],
          edges: [aresta('e-3', 'no-1', 'no-9')],
        });
        expect(result.success).toBe(false);
        expect(mensagensDe(result)).toContain('aresta "e-3" aponta para nó inexistente: "no-9"');
      });

      it('rejeita dois nós com o mesmo id', () => {
        const result = flowGraphSchema.safeParse({
          nodes: [noTrigger('no-1'), noTrigger('no-1'), noEnd('no-2')],
          edges: [aresta('e-1', 'no-1', 'no-2')],
        });
        expect(result.success).toBe(false);
        expect(mensagensDe(result)).toContain('id de nó repetido: "no-1"');
      });

      it('rejeita duas arestas com o mesmo id', () => {
        const result = flowGraphSchema.safeParse({
          nodes: [noTrigger('no-1'), noEnd('no-2')],
          edges: [aresta('e-2', 'no-1', 'no-2'), aresta('e-2', 'no-1', 'no-2')],
        });
        expect(result.success).toBe(false);
        expect(mensagensDe(result)).toContain('id de aresta repetido: "e-2"');
      });

      it('CONTROLE: campo desconhecido continua rejeitado', () => {
        const result = flowGraphSchema.safeParse({
          nodes: [noTrigger('no-1'), noEnd('no-2')],
          edges: [aresta('e-1', 'no-1', 'no-2')],
          campo_desconhecido: true,
        });
        expect(result.success).toBe(false);
      });
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

  /**
   * A graph exactly as a clone has it stored in `followup_flow_versions.graph`
   * TODAY: written by the pre-branches contract, already through `parse` once
   * (so `combinator`, `target` and `priority` are materialised), fan-out done
   * with `class_match` / `cond_result`. Frozen on purpose — nothing in here may
   * be "modernised" to keep a test green; the point is that the OLD bytes still
   * work. Published flows in the wild depend on every assertion below.
   */
  const LEGACY_V1_GRAPH = {
    nodes: [
      { id: 't1', type: 'trigger', label: 'Início', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'a1',
        type: 'action',
        label: 'Primeiro toque',
        position: { x: 0, y: 120 },
        config: { mode: 'ai_message', prompt_hint: 'pergunte se ainda faz sentido' },
      },
      {
        id: 'ac1',
        type: 'ai_classify',
        label: 'Leu a resposta?',
        position: { x: 0, y: 240 },
        config: {
          classes: ['quente', 'frio'],
          grace_timeout_ms: 900_000,
          target: 'last_reply',
        },
      },
      {
        id: 'c1',
        type: 'condition',
        label: 'É VIP?',
        position: { x: 0, y: 360 },
        config: {
          combinator: 'and',
          checks: [
            { field: 'tag', op: 'contains', value: 'vip' },
            { field: 'steps_taken', op: 'gte', value: 2 },
          ],
        },
      },
      {
        id: 'e1',
        type: 'end',
        label: 'Fim',
        position: { x: 0, y: 480 },
        config: { outcome: 'exhausted' },
      },
    ],
    edges: [
      { id: 'x1', source: 't1', target: 'a1', priority: 0, condition: { type: 'always' } },
      { id: 'x2', source: 'a1', target: 'ac1', priority: 0, condition: { type: 'always' } },
      { id: 'x3', source: 'ac1', target: 'c1', priority: 5, condition: { type: 'class_match', value: 'quente' } },
      { id: 'x4', source: 'ac1', target: 'e1', priority: 5, condition: { type: 'class_match', value: 'frio' } },
      { id: 'x5', source: 'ac1', target: 'e1', priority: 5, condition: { type: 'class_match', value: 'no_reply' } },
      { id: 'x6', source: 'ac1', target: 'e1', priority: 0, condition: { type: 'always' } },
      { id: 'x7', source: 'c1', target: 'e1', priority: 5, condition: { type: 'cond_result', value: true } },
      { id: 'x8', source: 'c1', target: 'e1', priority: 5, condition: { type: 'cond_result', value: false } },
    ],
  } as const;

  function parseLegacy(): FlowGraph {
    const result = flowGraphSchema.safeParse(LEGACY_V1_GRAPH);
    if (!result.success) {
      throw new Error(`legacy graph no longer parses: ${JSON.stringify(result.error.issues)}`);
    }
    return result.data;
  }

  describe('v1 graph compatibility (published flows in clones)', () => {
    it('parses a stored v1 graph back byte-identical — the v2 fields are additive, never injected', () => {
      const parsed = parseLegacy();
      // toStrictEqual, not toEqual: a defaulted `branching`/`branches` would show
      // up as an added (or explicitly-undefined) key and must fail here.
      expect(parsed).toStrictEqual(LEGACY_V1_GRAPH);
    });

    it('survives the builder round-trip (parse -> mappers -> fromReactFlow -> parse) unchanged', () => {
      const parsed = parseLegacy();
      const { nodes, edges } = toReactFlow(parsed);
      const rebuilt = flowGraphSchema.safeParse(fromReactFlow(nodes, edges));
      expect(rebuilt.success).toBe(true);
      if (rebuilt.success) {
        expect(rebuilt.data).toStrictEqual(parsed);
      }
    });

    it('keeps emitting the v1 edge dialect for a v1 ai_classify node — a published flow is never rewritten', () => {
      const node = parseLegacy().nodes.find((n) => n.id === 'ac1')!;
      expect(nodeBranches(node)).toStrictEqual([
        { id: 'quente', label: 'quente', check: null, kind: 'match', condition: { type: 'class_match', value: 'quente' } },
        { id: 'frio', label: 'frio', check: null, kind: 'match', condition: { type: 'class_match', value: 'frio' } },
        {
          id: NO_REPLY_BRANCH_ID,
          label: 'Sem resposta',
          check: null,
          kind: 'match',
          condition: { type: 'class_match', value: 'no_reply' },
        },
        { id: FALLBACK_BRANCH_ID, label: 'Sempre', check: null, kind: 'fallback', condition: { type: 'always' } },
      ]);
    });

    it('keeps emitting the v1 edge dialect for a v1 condition node (combined Sim/Não)', () => {
      const node = parseLegacy().nodes.find((n) => n.id === 'c1')!;
      expect(nodeBranches(node)).toStrictEqual([
        {
          id: CONDITION_TRUE_BRANCH_ID,
          label: 'Sim',
          check: null,
          kind: 'match',
          condition: { type: 'cond_result', value: true },
        },
        {
          id: CONDITION_FALSE_BRANCH_ID,
          label: 'Não',
          check: null,
          kind: 'match',
          condition: { type: 'cond_result', value: false },
        },
        { id: FALLBACK_BRANCH_ID, label: 'Sempre', check: null, kind: 'fallback', condition: { type: 'always' } },
      ]);
    });

    it('resolves every stored v1 edge to a branch that exists on its source node', () => {
      const graph = parseLegacy();
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      for (const edge of graph.edges) {
        const branchId = branchIdForCondition(byId.get(edge.source), edge.condition);
        expect(branchId, `edge ${edge.id} lost its branch`).not.toBeNull();
        expect(conditionForBranch(byId.get(edge.source)!, branchId!)).toStrictEqual(edge.condition);
      }
    });

    it('leaves a node with a single output with exactly one branch: the fallback', () => {
      const graph = parseLegacy();
      for (const id of ['t1', 'a1', 'e1']) {
        const branches = nodeBranches(graph.nodes.find((n) => n.id === id)!);
        expect(branches).toStrictEqual([
          { id: FALLBACK_BRANCH_ID, label: 'Sempre', check: null, kind: 'fallback', condition: { type: 'always' } },
        ]);
      }
    });
  });

  describe('named branches (graph v2)', () => {
    const perCheckConfig = {
      combinator: 'and' as const,
      branching: 'per_check' as const,
      checks: [
        { id: 'chk_vip', label: 'Cliente VIP', field: 'tag' as const, op: 'contains' as const, value: 'vip' },
        { id: 'chk_frio', field: 'steps_taken' as const, op: 'gte' as const, value: 3 },
      ],
    };

    function conditionNode(config: unknown): FlowNode {
      const parsed = flowNodeSchema.safeParse({
        id: 'c9',
        type: 'condition',
        label: 'Triagem',
        position: { x: 0, y: 0 },
        config,
      });
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      return parsed.data;
    }

    describe('condition config', () => {
      it('accepts per_check branching when every check carries an id', () => {
        expect(conditionConfigSchema.safeParse(perCheckConfig).success).toBe(true);
      });

      it('rejects per_check when a check has no id — the edge would reference nothing', () => {
        const result = conditionConfigSchema.safeParse({
          ...perCheckConfig,
          checks: [perCheckConfig.checks[0], { field: 'tag', op: 'eq', value: 'x' }],
        });
        expect(result.success).toBe(false);
      });

      it('rejects duplicate check ids', () => {
        const result = conditionConfigSchema.safeParse({
          ...perCheckConfig,
          checks: [
            { id: 'same', field: 'tag', op: 'eq', value: 'a' },
            { id: 'same', field: 'tag', op: 'eq', value: 'b' },
          ],
        });
        expect(result.success).toBe(false);
      });

      it.each(RESERVED_BRANCH_IDS)('rejects the reserved branch id %s on a check', (reserved) => {
        const result = conditionConfigSchema.safeParse({
          ...perCheckConfig,
          checks: [{ id: reserved, field: 'tag', op: 'eq', value: 'a' }],
        });
        expect(result.success).toBe(false);
      });

      it('keeps the v1 config valid with no branching field at all', () => {
        const result = conditionConfigSchema.safeParse({
          combinator: 'or',
          checks: [{ field: 'tag', op: 'contains', value: 'vip' }],
        });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data).toStrictEqual({
          combinator: 'or',
          checks: [{ field: 'tag', op: 'contains', value: 'vip' }],
        });
      });
    });

    describe('ai_classify config', () => {
      const withBranches = {
        classes: ['quente', 'frio'],
        branches: [
          { id: 'br_q', label: 'quente' },
          { id: 'br_f', label: 'frio' },
        ],
        grace_timeout_ms: 900_000,
        target: 'last_reply' as const,
      };

      it('accepts branches that mirror classes in order', () => {
        expect(aiClassifyConfigSchema.safeParse(withBranches).success).toBe(true);
      });

      it('rejects branches drifting from classes — the engine feeds the LLM from classes', () => {
        const result = aiClassifyConfigSchema.safeParse({
          ...withBranches,
          classes: ['quente', 'morno'],
        });
        expect(result.success).toBe(false);
      });

      it('rejects branches ordered differently from classes', () => {
        const result = aiClassifyConfigSchema.safeParse({
          ...withBranches,
          branches: [
            { id: 'br_f', label: 'frio' },
            { id: 'br_q', label: 'quente' },
          ],
        });
        expect(result.success).toBe(false);
      });

      it('rejects duplicate branch ids', () => {
        const result = aiClassifyConfigSchema.safeParse({
          ...withBranches,
          branches: [
            { id: 'dup', label: 'quente' },
            { id: 'dup', label: 'frio' },
          ],
        });
        expect(result.success).toBe(false);
      });

      it.each(RESERVED_BRANCH_IDS)('rejects the reserved branch id %s', (reserved) => {
        const result = aiClassifyConfigSchema.safeParse({
          classes: ['quente'],
          branches: [{ id: reserved, label: 'quente' }],
          grace_timeout_ms: 900_000,
        });
        expect(result.success).toBe(false);
      });
    });

    describe('edge condition', () => {
      it('accepts a branch condition', () => {
        const result = flowEdgeSchema.safeParse({
          id: 'e1',
          source: 'c9',
          target: 'end',
          condition: { type: 'branch', branch_id: 'chk_vip' },
        });
        expect(result.success).toBe(true);
      });

      it(`rejects branch_id "${FALLBACK_BRANCH_ID}" — the fallback has exactly one spelling on the wire`, () => {
        const result = flowEdgeSchema.safeParse({
          id: 'e1',
          source: 'c9',
          target: 'end',
          condition: { type: 'branch', branch_id: FALLBACK_BRANCH_ID },
        });
        expect(result.success).toBe(false);
      });
    });

    describe('nodeBranches', () => {
      it('gives a per_check condition one output per rule plus the mandatory fallback, last', () => {
        const branches = nodeBranches(conditionNode(perCheckConfig));
        expect(branches).toStrictEqual([
          {
            id: 'chk_vip',
            label: 'Cliente VIP',
            check: { id: 'chk_vip', label: 'Cliente VIP', field: 'tag', op: 'contains', value: 'vip' },
            kind: 'match',
            condition: { type: 'branch', branch_id: 'chk_vip' },
          },
          {
            id: 'chk_frio',
            label: null,
            check: { id: 'chk_frio', field: 'steps_taken', op: 'gte', value: 3 },
            kind: 'match',
            condition: { type: 'branch', branch_id: 'chk_frio' },
          },
          {
            id: FALLBACK_BRANCH_ID,
            label: 'Nenhuma delas',
            check: null,
            kind: 'fallback',
            condition: { type: 'always' },
          },
        ]);
      });

      /**
       * O contrato não inventa pt-br derivado de uma regra: quem compõe a frase é
       * `vocabulario.ts` (`fraseDaCondicao`), que já tem um dicionário por par
       * campo-operador. Este teste é a trava contra um SEGUNDO dicionário nascer
       * aqui — foi o que aconteceu quando duas frentes convergiram sozinhas e o
       * merge não acusou conflito.
       */
      it('leaves an unnamed rule without text and hands the rule over for the vocabulary to phrase', () => {
        const semRotulo = nodeBranches(conditionNode(perCheckConfig))[1]!;
        expect(semRotulo.label).toBeNull();
        expect(semRotulo.check).toStrictEqual({
          id: 'chk_frio',
          field: 'steps_taken',
          op: 'gte',
          value: 3,
        });
      });

      it('carries no rule on a branch that is not per_check — nothing to phrase there', () => {
        const combinado = nodeBranches(
          conditionNode({ combinator: 'and', checks: [{ field: 'tag', op: 'eq', value: 'a' }] })
        );
        expect(combinado.every((b) => b.check === null)).toBe(true);
        expect(combinado.every((b) => typeof b.label === 'string')).toBe(true);
      });

      it('exposes exactly one fallback branch per node, always last', () => {
        const nodes = [conditionNode(perCheckConfig), conditionNode({ combinator: 'and', checks: [{ field: 'tag', op: 'eq', value: 'a' }] })];
        for (const node of nodes) {
          const branches = nodeBranches(node);
          expect(branches.filter((b) => b.kind === 'fallback')).toHaveLength(1);
          expect(branches.at(-1)!.kind).toBe('fallback');
        }
      });

      it('match_reply: declared branches + no_reply + always fallback (v2 only)', () => {
        const node = flowNodeSchema.parse({
          id: 'mr1',
          type: 'match_reply',
          label: 'Texto',
          position: { x: 0, y: 0 },
          config: {
            branches: [
              { id: 'br_sim', label: 'Sim', op: 'eq', pattern: 'sim' },
              { id: 'br_nao', label: 'Não', op: 'contains', pattern: 'nao' },
            ],
            grace_timeout_ms: 900_000,
          },
        });
        const branches = nodeBranches(node);
        expect(branches.map((b) => b.id)).toEqual(['br_sim', 'br_nao', NO_REPLY_BRANCH_ID, FALLBACK_BRANCH_ID]);
        expect(branches[0]!.condition).toEqual({ type: 'branch', branch_id: 'br_sim' });
        expect(branches[2]!.condition).toEqual({ type: 'branch', branch_id: NO_REPLY_BRANCH_ID });
        expect(branches.at(-1)!.condition).toEqual({ type: 'always' });
      });
    });

    describe('the reported bug: renaming an output must not detach its edge', () => {
      function classifyNode(branches: { id: string; label: string }[]): FlowNode {
        const parsed = flowNodeSchema.safeParse({
          id: 'ac9',
          type: 'ai_classify',
          label: 'Triagem',
          position: { x: 0, y: 0 },
          config: {
            classes: branches.map((b) => b.label),
            branches,
            grace_timeout_ms: 900_000,
            target: 'last_reply',
          },
        });
        if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
        return parsed.data;
      }

      it('keeps the edge pointing at the same branch after the class is renamed', () => {
        const before = classifyNode([{ id: 'br_q', label: 'quente' }]);
        const edgeCondition = conditionForBranch(before, 'br_q');
        expect(edgeCondition).toStrictEqual({ type: 'branch', branch_id: 'br_q' });

        const after = classifyNode([{ id: 'br_q', label: 'muito quente' }]);
        expect(branchIdForCondition(after, edgeCondition!)).toBe('br_q');
      });

      it('shows the v1 failure mode it replaces: a class_match edge detaches on rename', () => {
        const renamed = flowNodeSchema.parse({
          id: 'ac9',
          type: 'ai_classify',
          label: 'Triagem',
          position: { x: 0, y: 0 },
          config: { classes: ['muito quente'], grace_timeout_ms: 900_000, target: 'last_reply' },
        });
        expect(branchIdForCondition(renamed, { type: 'class_match', value: 'quente' })).toBeNull();
      });

      it('returns null for a branch id that names nothing on the source node', () => {
        const node = conditionNode(perCheckConfig);
        expect(branchIdForCondition(node, { type: 'branch', branch_id: 'chk_apagado' })).toBeNull();
      });

      it('still resolves a leftover v1 edge hanging off a migrated v2 node', () => {
        const node = classifyNode([{ id: 'br_q', label: 'quente' }]);
        expect(branchIdForCondition(node, { type: 'class_match', value: 'quente' })).toBe('br_q');
      });
    });
  });
});
