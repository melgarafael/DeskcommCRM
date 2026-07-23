import { z } from 'zod';

/**
 * Flow graph schema for the follow-up automation system.
 * Defines types and Zod validators for nodes, edges, and complete graphs.
 */

export const NODE_TYPES = [
  'trigger',
  'wait',
  'condition',
  'ai_classify',
  'action',
  'end',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Wait node configuration schema.
 * Supports two modes:
 * - fixed: absolute wait duration in milliseconds (5 min to 90 days)
 * - smart: adaptive wait with min/max range and optional guidance
 */
export const waitConfigSchema = z
  .discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('fixed'),
      duration_ms: z.number().int().min(300_000).max(7_776_000_000),
    }),
    z.strictObject({
      mode: z.literal('smart'),
      min_ms: z.number().int().min(300_000),
      max_ms: z.number().int().max(7_776_000_000),
      guidance: z.string().max(500).optional(),
    }),
  ])
  .refine((c) => c.mode !== 'smart' || c.min_ms <= c.max_ms, {
    message: 'min_ms must be <= max_ms',
    path: ['min_ms'],
  });

/**
 * AI classification node configuration.
 * Classifies incoming messages into one of several predefined classes.
 */
export const aiClassifyConfigSchema = z.strictObject({
  classes: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(8),
  grace_timeout_ms: z.number().int().min(900_000), // 15 min minimum
  target: z.enum(['last_reply', 'summary']).default('last_reply'),
  hint: z.string().max(500).optional(),
});

/**
 * Action node configuration schema.
 * Supports two modes:
 * - ai_message: generate a message using AI with a prompt hint
 * - template: send a predefined template message
 */
export const actionConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('ai_message'),
    prompt_hint: z.string().min(1).max(1000),
    fallback_template_id: z.string().uuid().optional(),
  }),
  z.strictObject({
    mode: z.literal('template'),
    template_id: z.string().uuid(),
  }),
]);

/**
 * Condition node configuration.
 * Evaluates multiple checks against lead state using boolean logic.
 */
export const conditionConfigSchema = z.strictObject({
  combinator: z.enum(['and', 'or']).default('and'),
  checks: z
    .array(
      z.strictObject({
        field: z.enum([
          'lead_stage',
          'tag',
          'steps_taken',
          'last_outcome',
        ]),
        op: z.enum(['eq', 'neq', 'gte', 'lte', 'contains']),
        value: z.union([z.string(), z.number()]),
      })
    )
    .min(1)
    .max(10),
});

/**
 * End node configuration.
 * Marks the conclusion of a flow with an outcome.
 */
export const endConfigSchema = z.strictObject({
  outcome: z.enum(['converted', 'exhausted', 'custom']),
  note: z.string().max(200).optional(),
});

/**
 * Flow node schema — discriminated union based on node type.
 * Each node type has its specific config schema.
 */
export const flowNodeSchema = z.discriminatedUnion('type', [
  // Trigger node: entry point, no config
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('trigger'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: z.strictObject({}),
  }),
  // Wait node: pauses flow for a duration
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('wait'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: waitConfigSchema,
  }),
  // Condition node: branches flow based on criteria
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('condition'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: conditionConfigSchema,
  }),
  // AI Classify node: classifies messages
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('ai_classify'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: aiClassifyConfigSchema,
  }),
  // Action node: sends a message
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('action'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: actionConfigSchema,
  }),
  // End node: terminal state
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('end'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: endConfigSchema,
  }),
]);

export type FlowNode = z.infer<typeof flowNodeSchema>;

/**
 * Flow edge schema — connection between nodes.
 * Includes condition to determine when edge is traversed.
 */
export const flowEdgeSchema = z.strictObject({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  priority: z.number().int().default(0),
  condition: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('always') }),
    z.strictObject({
      type: z.literal('class_match'),
      value: z.string(), // e.g., 'hot', 'cold', 'no_reply'
    }),
    z.strictObject({
      type: z.literal('cond_result'),
      value: z.boolean(),
    }),
  ]),
});

export type FlowEdge = z.infer<typeof flowEdgeSchema>;

/**
 * Complete flow graph schema.
 * Contains nodes and edges defining the flow automation.
 */
export const flowGraphSchema = z.strictObject({
  nodes: z.array(flowNodeSchema).min(2).max(60),
  edges: z.array(flowEdgeSchema).max(120),
});

export type FlowGraph = z.infer<typeof flowGraphSchema>;
