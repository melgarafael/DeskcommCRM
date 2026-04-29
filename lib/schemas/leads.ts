/**
 * Zod schemas for `/api/v1/leads/*` endpoints (EPIC-04 waves 1-3).
 *
 * Contracts:
 *  - moveLeadSchema   → POST /api/v1/leads/[id]/move (P-01, P-05, P-08)
 *  - winLeadSchema    → POST /api/v1/leads/[id]/win  (P-02, idempotent)
 *  - loseLeadSchema   → POST /api/v1/leads/[id]/lose (P-02, P-03)
 *  - bulkLeadActionSchema → POST /api/v1/leads/bulk  (AT-06, max 50)
 */
import { z } from "zod";

export const moveLeadSchema = z.object({
  stage_id: z.string().uuid(),
  position_in_stage: z.number().finite(),
  expected_updated_at: z.string().datetime(),
});
export type MoveLeadInput = z.infer<typeof moveLeadSchema>;

export const winLeadSchema = z.object({}).passthrough();
export type WinLeadInput = z.infer<typeof winLeadSchema>;

export const loseLeadSchema = z.object({
  lost_reason: z.string().min(1, "lost_reason é obrigatório").max(500),
});
export type LoseLeadInput = z.infer<typeof loseLeadSchema>;

export const bulkLeadActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("move"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({
      stage_id: z.string().uuid(),
      position_in_stage: z.number().finite(),
    }),
  }),
  z.object({
    action: z.literal("assign"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({ owner_user_id: z.string().uuid().nullable() }),
  }),
  z.object({
    action: z.literal("tag"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    action: z.literal("delete"),
    lead_ids: z.array(z.string().uuid()).min(1).max(50),
    params: z.object({}).optional(),
  }),
]);
export type BulkLeadActionInput = z.infer<typeof bulkLeadActionSchema>;
