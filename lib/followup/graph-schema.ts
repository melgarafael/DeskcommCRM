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
  'match_reply',
  'repeat',
  'action',
  'end',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * ---------------------------------------------------------------------------
 * Named branches (graph v2)
 * ---------------------------------------------------------------------------
 * A fan-out node used to collapse N rules into ONE boolean (`condition`) or to
 * address its outputs by a mutable human string (`ai_classify` + `class_match`),
 * so the builder could only ever draw a single source handle and a rename
 * silently detached the edge. v2 gives every output of a node a STABLE ID —
 * the branch — and lets an edge reference `branch_id` instead.
 *
 * The branch belongs to the NODE, never to the edge: replicating the rule
 * inside the edge would duplicate the truth and break on reorder.
 *
 * Every v2 field below is OPTIONAL and every v1 field keeps its exact type, so
 * a graph written by the previous version parses byte-identical (no default is
 * injected, nothing is rewritten) and keeps routing through the v1 conditions.
 * Read the storage shape through `nodeBranches()` — it is the only place that
 * knows which dialect a node speaks.
 */

/** The catch-all output every node has. Spelled `{ type: 'always' }` on the wire — never as a `branch`. */
export const FALLBACK_BRANCH_ID = 'else';
/** `ai_classify` grace timeout expired without a classification. */
export const NO_REPLY_BRANCH_ID = 'no_reply';
/** The two outputs of a `condition` node evaluating its checks together (`branching: 'combined'`). */
export const CONDITION_TRUE_BRANCH_ID = 'true';
export const CONDITION_FALSE_BRANCH_ID = 'false';
/** Saída do `repeat` enquanto ainda faltam voltas. */
export const REPEAT_BODY_BRANCH_ID = 'body';
/** Saída do `repeat` quando o contador chegou a zero. */
export const REPEAT_DONE_BRANCH_ID = 'done';

/** Branch ids the contract owns — a user-declared branch may not claim one. */
export const RESERVED_BRANCH_IDS = [
  FALLBACK_BRANCH_ID,
  NO_REPLY_BRANCH_ID,
  CONDITION_TRUE_BRANCH_ID,
  CONDITION_FALSE_BRANCH_ID,
  REPEAT_BODY_BRANCH_ID,
  REPEAT_DONE_BRANCH_ID,
] as const;

/** Id of a branch the user declared (a check, an AI class) — opaque, stable across renames. */
export const declaredBranchIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((id) => !(RESERVED_BRANCH_IDS as readonly string[]).includes(id), {
    message: `branch id is reserved: ${RESERVED_BRANCH_IDS.join(', ')}`,
  });

/** Id an edge may reference. Excludes the fallback, which has exactly one spelling: `{ type: 'always' }`. */
export const edgeBranchIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((id) => id !== FALLBACK_BRANCH_ID, {
    message: `the fallback branch "${FALLBACK_BRANCH_ID}" is spelled { type: 'always' } on an edge`,
  });

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

/** A declared output of an `ai_classify` node: opaque id + the class name the LLM is asked to pick. */
export const aiClassBranchSchema = z.strictObject({
  id: declaredBranchIdSchema,
  label: z.string().min(1).max(40),
});

export type AiClassBranch = z.infer<typeof aiClassBranchSchema>;

/** Declared output of a `match_reply` node: opaque id + the text rule (no LLM). */
export const matchReplyBranchSchema = z.strictObject({
  id: declaredBranchIdSchema,
  label: z.string().min(1).max(40),
  op: z.enum(['eq', 'contains']),
  pattern: z.string().min(1).max(200),
});

export type MatchReplyBranch = z.infer<typeof matchReplyBranchSchema>;

/**
 * Where to write the contact's reply. `{{volta}}` in a custom key is replaced
 * with the current `repeat` index when the node sits inside a loop.
 */
export const replySaveToSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('contact_name') }),
  z.strictObject({
    kind: z.literal('lead_custom'),
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_{}]*$/i, 'Use letras, números, underscore ou {{volta}}'),
  }),
]);
export type ReplySaveTo = z.infer<typeof replySaveToSchema>;

/** O que fazer quando o destino de `save_to` já tem valor (captação, ficha…). */
export const ifExistsSchema = z.enum(["skip", "overwrite", "confirm"]);
export type IfExists = z.infer<typeof ifExistsSchema>;

/**
 * Text-match node: parks in `waiting_reply` like `ai_classify`, then routes on
 * the last inbound body without calling a model. v2 `branches` only.
 */
export const matchReplyConfigSchema = z
  .strictObject({
    branches: z.array(matchReplyBranchSchema).min(1).max(8),
    grace_timeout_ms: z.number().int().min(900_000),
    save_to: replySaveToSchema.optional(),
    if_exists: ifExistsSchema.optional(),
  })
  .refine((c) => new Set(c.branches.map((b) => b.id)).size === c.branches.length, {
    message: "branches[].id must be unique within the node",
    path: ["branches"],
  });

/**
 * Repete o caminho `body` N vezes, onde N vem da última resposta do contato
 * (um número, ou palavras tipo "nenhum"/"dois"), limitado por `max_count`.
 * Estado mora nos eventos do enrollment — voltar ao nó não relê a resposta.
 */
export const repeatConfigSchema = z.strictObject({
  max_count: z.number().int().min(1).max(20),
});

/**
 * AI classification node configuration.
 * Classifies incoming messages into one of several predefined classes.
 *
 * `branches` (v2) is the source of truth for identity AND label; `classes`
 * stays the ordered class vocabulary the engine hands the LLM
 * (`engine.ts` buildClassifyPayload) and is a validated projection of it — the
 * refine below rejects any graph where the two drift, so the mirror cannot rot.
 * A node without `branches` is a v1 node: the class string is its own branch id
 * (which is exactly the rename bug — v1 nodes keep the old behaviour until the
 * builder migrates them, they just don't get stable ids for free).
 */
export const aiClassifyConfigSchema = z
  .strictObject({
    classes: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(8),
    branches: z.array(aiClassBranchSchema).min(1).max(8).optional(),
    grace_timeout_ms: z.number().int().min(900_000), // 15 min minimum
    target: z.enum(['last_reply', 'summary']).default('last_reply'),
    hint: z.string().max(500).optional(),
  })
  .refine((c) => !c.branches || new Set(c.branches.map((b) => b.id)).size === c.branches.length, {
    message: 'branches[].id must be unique within the node',
    path: ['branches'],
  })
  .refine(
    (c) =>
      !c.branches ||
      (c.branches.length === c.classes.length &&
        c.branches.every((b, i) => b.label === c.classes[i])),
    {
      message: 'classes must mirror branches[].label in the same order (branches is the source of truth)',
      path: ['classes'],
    }
  );

/**
 * Action node configuration schema.
 * - text: send this body as-is (no model)
 * - ai_message: generate a message using AI with a prompt hint
 * - template: send a canned message from Ajustes → Modelos
 */
export const actionConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('text'),
    body: z.string().min(1).max(4000),
  }),
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
 * One rule of a `condition` node. In `branching: 'per_check'` it IS a branch,
 * so it carries the stable id an edge references and the label the handle shows
 * — identity lives on the rule itself, never in a parallel array that would
 * desync the moment the user reorders the rules.
 */
export const conditionCheckSchema = z.strictObject({
  id: declaredBranchIdSchema.optional(),
  label: z.string().min(1).max(60).optional(),
  field: z.enum([
    'lead_stage',
    'tag',
    'steps_taken',
    'last_outcome',
  ]),
  op: z.enum(['eq', 'neq', 'gte', 'lte', 'contains']),
  value: z.union([z.string(), z.number()]),
});

export type ConditionCheck = z.infer<typeof conditionCheckSchema>;

/**
 * Condition node configuration.
 * Evaluates multiple checks against lead state using boolean logic.
 *
 * `branching` picks how the checks reach the canvas:
 * - `combined` (also: absent — every published v1 flow) — `combinator` folds the
 *   checks into one boolean and the node has the two fixed outputs Sim/Não.
 * - `per_check` — one output per rule, plus the mandatory fallback. `combinator`
 *   is not consulted in this mode (a rule no longer votes, it routes).
 */
export const conditionConfigSchema = z
  .strictObject({
    combinator: z.enum(['and', 'or']).default('and'),
    branching: z.enum(['combined', 'per_check']).optional(),
    checks: z.array(conditionCheckSchema).min(1).max(10),
  })
  .refine(
    (c) => {
      const ids = c.checks.flatMap((chk) => (chk.id === undefined ? [] : [chk.id]));
      return new Set(ids).size === ids.length;
    },
    { message: 'checks[].id must be unique within the node', path: ['checks'] }
  )
  .refine((c) => c.branching !== 'per_check' || c.checks.every((chk) => chk.id !== undefined), {
    message: "branching 'per_check' requires an id on every check — it is what the edge references",
    path: ['checks'],
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
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('match_reply'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: matchReplyConfigSchema,
  }),
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('repeat'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: repeatConfigSchema,
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
 *
 * `branch` is the v2 spelling: it names an output of the SOURCE node by its
 * stable id, so renaming what the user sees never detaches the edge.
 * `class_match` / `cond_result` are the v1 spellings — still valid, still
 * routed, emitted only by nodes that haven't declared branches. Which dialect
 * an edge should use is decided by the source node, not by the editor: see
 * `nodeBranches()`.
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
    z.strictObject({
      type: z.literal('branch'),
      branch_id: edgeBranchIdSchema,
    }),
  ]),
});

export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type FlowEdgeCondition = FlowEdge['condition'];

/**
 * Complete flow graph schema.
 * Contains nodes and edges defining the flow automation.
 *
 * O `strictObject` valida cada nó e cada aresta SOZINHOS; o `superRefine`
 * abaixo é a catraca de INTEGRIDADE entre eles. Sem ela, um grafo com aresta
 * apontando para nó inexistente ou com ids repetidos (o defeito que o #586
 * produz no canvas) passava no `safeParse` de qualquer consumidor — salvar o
 * rascunho (`draft_graph`), carregar a versão (engine, turn-bridge, enroll,
 * silence-sweep, intervenção) e publicar. A porta é a mesma para todos: quem
 * JÁ tiver rascunho corrompido recebe o erro com o id a corrigir em vez de um
 * grafo que só quebra adiante, no meio de um disparo. Sem migração de
 * rascunho — decisão registrada na issue #699.
 */
export const flowGraphSchema = z
  .strictObject({
    nodes: z.array(flowNodeSchema).min(2).max(60),
    edges: z.array(flowEdgeSchema).max(120),
  })
  .superRefine((grafo, ctx) => {
    const idsDeNo = new Set<string>();
    grafo.nodes.forEach((no, i) => {
      if (idsDeNo.has(no.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `id de nó repetido: "${no.id}"`,
          path: ['nodes', i],
        });
      }
      idsDeNo.add(no.id);
    });

    const idsDeAresta = new Set<string>();
    grafo.edges.forEach((aresta, i) => {
      if (idsDeAresta.has(aresta.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `id de aresta repetido: "${aresta.id}"`,
          path: ['edges', i],
        });
      }
      idsDeAresta.add(aresta.id);

      if (!idsDeNo.has(aresta.source)) {
        ctx.addIssue({
          code: 'custom',
          message: `aresta "${aresta.id}" aponta para nó inexistente: "${aresta.source}"`,
          path: ['edges', i],
        });
      }
      if (!idsDeNo.has(aresta.target)) {
        ctx.addIssue({
          code: 'custom',
          message: `aresta "${aresta.id}" aponta para nó inexistente: "${aresta.target}"`,
          path: ['edges', i],
        });
      }
    });
  });

export type FlowGraph = z.infer<typeof flowGraphSchema>;

/**
 * ---------------------------------------------------------------------------
 * Branch resolution — the single reader of the storage dialect
 * ---------------------------------------------------------------------------
 * Node configs differ per type and per version (v1 `classes: string[]` vs v2
 * `branches`, `combinator` vs `per_check`). Everything downstream — the canvas
 * handles, the edge panel, publish validation, the engine's routing — must go
 * through `nodeBranches()` and never read the raw shape, so the compatibility
 * cost is paid exactly once, here.
 *
 * ⚠️ MIGRAR UM NÓ DE v1 PARA v2 NÃO É SÓ TROCAR A CONFIG. `branchIdForCondition`
 * aceita, num nó v2, uma aresta legada `class_match` casando pelo RÓTULO — isso
 * existe para o canvas continuar desenhando um nó meio-migrado sem perder a
 * linha. O ROTEAMENTO não tem essa cortesia: `classEdgeMatch` (node-handlers)
 * devolve `{type:'branch'}` e `selectEdge` não casa a aresta antiga, caindo no
 * `always`. O resultado é tela correta com roteamento errado, e nada acusa.
 *
 * Portanto: dar `branches` a um nó que já tem arestas exige reescrever essas
 * arestas no MESMO instante — operação de canvas, atômica. É por isso que o
 * `ClassifyForm` ainda emite v1 de propósito; a ressalva está lá também.
 */

/**
 * What branch resolution actually reads off a node: its type and its config.
 * Written as a mapped union instead of `Pick<FlowNode, 'type' | 'config'>`
 * because `Pick` over a union flattens it and loses the correlation between the
 * two — and because the builder holds React Flow nodes, which have no
 * `position` in the shape this file expects. A full `FlowNode` is assignable.
 */
export type BranchableNode = {
  [K in NodeType]: Pick<Extract<FlowNode, { type: K }>, 'type' | 'config'>;
}[NodeType];

/** `fallback` is the mandatory catch-all: exactly one per node, never deletable in the builder. */
export type FlowBranchKind = 'match' | 'fallback';

export type FlowBranch = {
  /** Stable within the node. Reserved ids are contract-owned; the rest come from the user's config. */
  id: string;
  /**
   * Text that is ALREADY decided: what the user typed (the rule's label, the
   * class name) or a fixed term of the contract. `null` on a `per_check` branch
   * the user never named — there the sentence is COMPOSED from `check`, and
   * composing pt-br out of a rule is the vocabulary's job (`vocabulario.ts`,
   * `fraseDaCondicao`), not the contract's. This file must not grow a second
   * field/operator dictionary next to that one.
   */
  label: string | null;
  /** The rule behind a `per_check` branch, so the vocabulary can phrase it. `null` on every other branch. */
  check: ConditionCheck | null;
  kind: FlowBranchKind;
  /** The condition an edge leaving through this branch must carry — canonical for THIS node's dialect. */
  condition: FlowEdgeCondition;
};

const FALLBACK_ALWAYS_LABEL = 'Sempre';
const FALLBACK_NONE_LABEL = 'Nenhuma delas';
const NO_REPLY_LABEL = 'Sem resposta';

function fallbackBranch(label: string): FlowBranch {
  return {
    id: FALLBACK_BRANCH_ID,
    label,
    check: null,
    kind: 'fallback',
    condition: { type: 'always' },
  };
}

/**
 * Every output of `node`, in the order the builder should draw the handles,
 * with the mandatory fallback last. A v1 node yields v1 conditions and a v2
 * node yields `branch` conditions — a published flow is never rewritten just
 * because the contract grew.
 */
export function nodeBranches(node: BranchableNode): FlowBranch[] {
  switch (node.type) {
    case 'condition': {
      if (node.config.branching === 'per_check') {
        const branches: FlowBranch[] = node.config.checks.flatMap((check) =>
          check.id === undefined
            ? [] // unreachable for a parsed config: 'per_check' refines every check to have an id
            : [
                {
                  id: check.id,
                  label: check.label ?? null, // null: o vocabulário monta a frase a partir de `check`
                  check,
                  kind: 'match' as const,
                  condition: { type: 'branch' as const, branch_id: check.id },
                },
              ]
        );
        return [...branches, fallbackBranch(FALLBACK_NONE_LABEL)];
      }
      return [
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
        fallbackBranch(FALLBACK_ALWAYS_LABEL),
      ];
    }

    case 'ai_classify': {
      const declared = node.config.branches;
      const classBranches: FlowBranch[] = declared
        ? declared.map((b) => ({
            id: b.id,
            label: b.label,
            check: null,
            kind: 'match' as const,
            condition: { type: 'branch' as const, branch_id: b.id },
          }))
        : node.config.classes.map((cls) => ({
            id: cls, // v1: the class string is its own branch id
            label: cls,
            check: null,
            kind: 'match' as const,
            condition: { type: 'class_match' as const, value: cls },
          }));
      return [
        ...classBranches,
        {
          id: NO_REPLY_BRANCH_ID,
          label: NO_REPLY_LABEL,
          check: null,
          kind: 'match',
          condition: declared
            ? { type: 'branch', branch_id: NO_REPLY_BRANCH_ID }
            : { type: 'class_match', value: NO_REPLY_BRANCH_ID },
        },
        fallbackBranch(FALLBACK_ALWAYS_LABEL),
      ];
    }

    case 'match_reply': {
      const classBranches: FlowBranch[] = node.config.branches.map((b) => ({
        id: b.id,
        label: b.label,
        check: null,
        kind: 'match' as const,
        condition: { type: 'branch' as const, branch_id: b.id },
      }));
      return [
        ...classBranches,
        {
          id: NO_REPLY_BRANCH_ID,
          label: NO_REPLY_LABEL,
          check: null,
          kind: 'match',
          condition: { type: 'branch', branch_id: NO_REPLY_BRANCH_ID },
        },
        fallbackBranch(FALLBACK_ALWAYS_LABEL),
      ];
    }

    case 'repeat':
      return [
        {
          id: REPEAT_BODY_BRANCH_ID,
          label: 'Próxima volta',
          check: null,
          kind: 'match',
          condition: { type: 'branch', branch_id: REPEAT_BODY_BRANCH_ID },
        },
        {
          id: REPEAT_DONE_BRANCH_ID,
          label: 'Acabou',
          check: null,
          kind: 'match',
          condition: { type: 'branch', branch_id: REPEAT_DONE_BRANCH_ID },
        },
        fallbackBranch(FALLBACK_ALWAYS_LABEL),
      ];

    default:
      return [fallbackBranch(FALLBACK_ALWAYS_LABEL)];
  }
}

/**
 * Which branch of `source` an edge condition serves, or `null` when it names
 * nothing on that node (a rule deleted while an edge still pointed at it —
 * publish validation's job to surface, not the parser's: rejecting it at parse
 * time would make a half-built draft unsaveable).
 * Accepts both dialects so a v2 node that still carries a leftover v1 edge
 * resolves instead of silently losing its route.
 */
export function branchIdForCondition(
  source: BranchableNode | undefined,
  condition: FlowEdgeCondition
): string | null {
  if (condition.type === 'always') return FALLBACK_BRANCH_ID;
  if (source === undefined) {
    return condition.type === 'branch'
      ? condition.branch_id
      : condition.type === 'class_match'
        ? condition.value
        : condition.value
          ? CONDITION_TRUE_BRANCH_ID
          : CONDITION_FALSE_BRANCH_ID;
  }

  const branches = nodeBranches(source);
  if (condition.type === 'branch') {
    return branches.some((b) => b.id === condition.branch_id) ? condition.branch_id : null;
  }
  if (condition.type === 'class_match') {
    // v1 spelling: the value is the branch id on a v1 node and the LABEL on a v2 one.
    const byId = branches.find((b) => b.id === condition.value);
    if (byId) return byId.id;
    const byLabel = branches.find((b) => b.kind === 'match' && b.label === condition.value);
    return byLabel?.id ?? null;
  }
  const id = condition.value ? CONDITION_TRUE_BRANCH_ID : CONDITION_FALSE_BRANCH_ID;
  return branches.some((b) => b.id === id) ? id : null;
}

/** The condition an edge must carry to leave `node` through `branchId` — `null` if no such branch. */
export function conditionForBranch(node: BranchableNode, branchId: string): FlowEdgeCondition | null {
  return nodeBranches(node).find((b) => b.id === branchId)?.condition ?? null;
}
