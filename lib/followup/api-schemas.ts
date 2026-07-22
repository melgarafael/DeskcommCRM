/**
 * Zod "shape" schemas for the follow-up flows REST API (Task 3.1).
 * Structural graph validation (min nodes, node/edge shape) lives in
 * `graph-schema.ts`; publish-time semantic checks (reachability, coverage)
 * live in `validate-publish.ts`. This file only covers request bodies.
 */
import { z } from "zod";
import { flowGraphSchema } from "./graph-schema";

export const createFollowupFlowSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
});

export const triggerConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    kind: z.literal("stage_change"),
    params: z.strictObject({ stage_id: z.string().uuid() }),
  }),
  z.strictObject({
    kind: z.literal("silence"),
    params: z.strictObject({
      threshold_minutes: z.number().int().min(5).max(10_080),
      segments: z.array(z.string()).optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal("conversation_end"),
    params: z.strictObject({}),
  }),
]);
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export const patchFollowupFlowSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  draft_graph: flowGraphSchema.optional(),
  handoff_policy: z.enum(["pause", "cancel", "allow"]).optional(),
  trigger_config: triggerConfigSchema.optional(),
});

export const rollbackFollowupFlowSchema = z.strictObject({
  version_id: z.string().uuid(),
});

export const createFollowupEnrollmentSchema = z.strictObject({
  pointer_id: z.string().uuid(),
  contact_id: z.string().uuid(),
});
