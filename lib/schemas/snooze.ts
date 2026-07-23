import { z } from "zod";

export const snoozeSchema = z.object({ duration_hours: z.union([z.literal(1), z.literal(3), z.literal(24)]) });
export type SnoozeInput = z.infer<typeof snoozeSchema>;
