/**
 * Zod schemas + cross-reference validators for the AI Agents module (mcp_agent kind).
 * Spec 10 §3.2 + §4.3 + §4.5.
 *
 * Convention: "shape" schemas (no business rules) ship from here; cross-row
 * checks (credential.validated_at, channel_session.status, model exists) live
 * in `validateVersionReferences` and run BEFORE save AND inside the publish
 * Postgres function (defense in depth).
 */
import { z } from "zod";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

const UUID = z.string().uuid();

const triggerConfigSchema = z
  .object({
    events: z.array(z.enum(["message"])).default(["message"]),
    filters: z
      .object({
        ignore_groups: z.boolean().default(true),
        ignore_self: z.boolean().default(true),
        keyword_regex: z.string().nullable().optional().default(null),
        business_hours: z
          .object({
            timezone: z.string(),
            start: z.string(),
            end: z.string(),
            weekdays: z.array(z.number().int().min(0).max(6)),
          })
          .nullable()
          .optional()
          .default(null),
      })
      .default({ ignore_groups: true, ignore_self: true, keyword_regex: null, business_hours: null }),
    concurrency: z.enum(["one_per_conversation", "one_per_contact"]).default("one_per_conversation"),
  })
  .strict();

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

// Task 7.2 — vínculo do agente com fluxos de follow-up publicados. Aditivo:
// `.default(...)` faz agents/versions existentes (sem este campo no payload)
// continuarem válidos, lidos com enabled=false/[] (comportamento inalterado).
// `flow_pointer_ids` referencia `followup_flow_pointers.id` — sem FK real de
// array no Postgres (mesma doutrina de `tool_ids`: domínio validado em app,
// não em constraint de banco).
const followupConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    flow_pointer_ids: z.array(UUID).max(20).default([]),
  })
  .strict()
  .default({ enabled: false, flow_pointer_ids: [] });

export type FollowupConfig = z.infer<typeof followupConfigSchema>;

const versionShapeSchema = z
  .object({
    system_prompt: z.string().trim().min(10).max(20000),
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1).max(120),
    credential_id: UUID,
    tool_ids: z
      .array(z.string().min(1).max(80))
      .max(20)
      .default([])
      .refine(
        (ids) => ids.every((id) => (VALID_TOOL_IDS as readonly string[]).includes(id)),
        { message: "tool_id_invalid" },
      ),
    trigger_config: triggerConfigSchema.optional(),
    channel_session_id: UUID,
    max_steps: z.number().int().min(1).max(25).default(10),
    token_budget: z.number().int().min(1000).max(500000).default(50000),
    cost_budget_cents: z.number().int().min(1).max(10000).default(50),
    history_message_window: z.number().int().min(0).max(200).default(20),
    history_token_window: z.number().int().min(0).max(50000).default(8000),
    handoff_keywords: z
      .array(z.string().trim().min(1).max(60))
      .max(20)
      .default(["falar com humano", "atendente", "pessoa real"]),
    handoff_tool_enabled: z.boolean().default(true),
    followup: followupConfigSchema,
  })
  .strict();

export type VersionInput = z.infer<typeof versionShapeSchema>;

export const versionCreateSchema = versionShapeSchema;

/** Edits permitted only on draft versions. All fields optional. */
export const versionPatchSchema = versionShapeSchema.partial();

export const agentMcpCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    priority: z.number().int().min(0).max(1000).default(0),
    version: versionShapeSchema,
  })
  .strict();

export const agentMcpPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

export const publishSchema = z.object({ version_id: UUID }).strict();

export const testRunSchema = z
  .object({
    sample_message: z.string().trim().min(1).max(4000),
    sample_contact: z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        phone: z.string().trim().min(3).max(40).optional(),
      })
      .optional(),
  })
  .strict();

export const runsListQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z
      .enum(["pending", "running", "completed", "failed", "aborted", "handoff"])
      .optional(),
  })
  .strict();

export type PublishErrorCode =
  | "agent_not_found"
  | "agent_archived"
  | "version_not_found"
  | "version_invalid_state"
  | "credential_missing"
  | "credential_not_found"
  | "credential_inactive"
  | "credential_not_validated"
  | "credential_provider_mismatch"
  | "channel_session_not_found"
  | "channel_session_offline"
  | "model_not_found"
  | "tool_id_invalid";

export const PUBLISH_ERROR_CODES: ReadonlySet<string> = new Set<PublishErrorCode>([
  "agent_not_found",
  "agent_archived",
  "version_not_found",
  "version_invalid_state",
  "credential_missing",
  "credential_not_found",
  "credential_inactive",
  "credential_not_validated",
  "credential_provider_mismatch",
  "channel_session_not_found",
  "channel_session_offline",
  "model_not_found",
  "tool_id_invalid",
]);
