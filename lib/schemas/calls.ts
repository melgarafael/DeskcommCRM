import { z } from "zod";

export const createCallSchema = z.object({
  toNumber: z.string().min(8),
  leadId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  mode: z.enum(["ai", "human"]).default("ai"),
});

export const listCallsQuerySchema = z.object({
  direction: z.enum(["outbound", "inbound"]).optional(),
  status: z
    .enum(["ringing", "in_progress", "completed", "no_answer", "busy", "failed", "canceled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
