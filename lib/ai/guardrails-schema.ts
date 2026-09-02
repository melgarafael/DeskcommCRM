/**
 * Zod source-of-truth para configuração de agents (config jsonb + guardrails jsonb).
 * Importado por backend (route handlers) e frontend (editor) — não duplicar.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Models permitidos (Vercel AI Gateway)
// ---------------------------------------------------------------------------

export const AGENT_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-opus-4-7",
] as const;

export const agentModelSchema = z.enum(AGENT_MODELS);
export type AgentModel = z.infer<typeof agentModelSchema>;

// ---------------------------------------------------------------------------
// Guardrails (5 kinds — Spec 05 §8.1)
// ---------------------------------------------------------------------------

export const guardrailKindEnum = z.enum([
  "regex_output_block",
  "rag_must_hit",
  "regex_input_block",
  "window_check",
  "contact_flag",
]);
export type GuardrailKind = z.infer<typeof guardrailKindEnum>;

const guardrailRegexOutputBlock = z.object({
  kind: z.literal("regex_output_block"),
  pattern: z.string().min(1),
  flags: z.string().optional().default("i"),
  reason: z.string().min(1),
});

const guardrailRagMustHit = z.object({
  kind: z.literal("rag_must_hit"),
  min_citations: z.number().int().min(1).max(10).default(1),
  reason: z.string().min(1),
});

const guardrailRegexInputBlock = z.object({
  kind: z.literal("regex_input_block"),
  pattern: z.string().min(1),
  flags: z.string().optional().default("i"),
  reason: z.string().min(1),
});

const guardrailWindowCheck = z.object({
  kind: z.literal("window_check"),
  start_hour: z.number().int().min(0).max(23),
  end_hour: z.number().int().min(0).max(23),
  timezone: z.string().default("Africa/Maputo"),
  reason: z.string().min(1),
});

const guardrailContactFlag = z.object({
  kind: z.literal("contact_flag"),
  field: z.enum(["force_human", "is_blocked", "is_vip"]),
  expected: z.boolean(),
  reason: z.string().min(1),
});

export const guardrailItemSchema = z.discriminatedUnion("kind", [
  guardrailRegexOutputBlock,
  guardrailRagMustHit,
  guardrailRegexInputBlock,
  guardrailWindowCheck,
  guardrailContactFlag,
]);
export type GuardrailItem = z.infer<typeof guardrailItemSchema>;

export const guardrailsSchema = z.array(guardrailItemSchema).max(50);
export type Guardrails = z.infer<typeof guardrailsSchema>;

// ---------------------------------------------------------------------------
// Agent config (vai dentro de ai_agents.config jsonb)
// ---------------------------------------------------------------------------

export const agentConfigSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.4),
  max_tokens: z.number().int().min(64).max(4096).default(1024),
  context_message_window: z.number().int().min(1).max(50).default(20),
  rag_top_k: z.number().int().min(1).max(20).default(5),
  rag_similarity_threshold: z.number().min(0).max(1).default(0.72),
  confidence_threshold: z.number().min(0).max(1).default(0.6),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const AGENT_CONFIG_DEFAULTS: AgentConfig = {
  temperature: 0.4,
  max_tokens: 1024,
  context_message_window: 20,
  rag_top_k: 5,
  rag_similarity_threshold: 0.72,
  confidence_threshold: 0.6,
};

// ---------------------------------------------------------------------------
// PATCH / CREATE schemas
// ---------------------------------------------------------------------------

export const agentPatchSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    is_active: z.boolean().optional(),
    model: agentModelSchema.optional(),
    system_prompt: z.string().min(20).max(10000).optional(),
    config: agentConfigSchema.partial().optional(),
    guardrails: guardrailsSchema.optional(),
  })
  .strict();
export type AgentPatch = z.infer<typeof agentPatchSchema>;

export const agentCreateSchema = z
  .object({
    name: z.string().min(2).max(120),
    description: z.string().max(500).nullable().optional(),
    model: agentModelSchema.optional(),
    system_prompt: z
      .string()
      .min(20)
      .max(10000)
      .default(
        "Você é um assistente da loja. Responda com clareza e cordialidade, em português de Moçambique. Use a base de conhecimento abaixo quando relevante.",
      ),
  })
  .strict();
export type AgentCreate = z.infer<typeof agentCreateSchema>;

// ---------------------------------------------------------------------------
// Placeholders disponíveis no system prompt (helper UI)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT_PLACEHOLDERS: Array<{ token: string; description: string }> = [
  { token: "{{vocabulary.lead}}", description: "Vocabulário do tenant para 'lead' (ex: cliente)" },
  { token: "{{vocabulary.deal}}", description: "Vocabulário do tenant para 'deal' (ex: pedido)" },
  { token: "{{vocabulary.won}}", description: "Vocabulário do tenant para 'won' (ex: pago)" },
  { token: "{{vocabulary.lost}}", description: "Vocabulário do tenant para 'lost' (ex: cancelado)" },
  { token: "{{contact_name}}", description: "Nome do contato em atendimento" },
  { token: "{{contact_locale}}", description: "Locale do contato (ex: pt-PT)" },
  { token: "{{recent_messages}}", description: "Últimas N mensagens da conversa" },
  { token: "{{retrieved_chunks}}", description: "Trechos da base de conhecimento (RAG)" },
];
