import { z } from "zod";

export const createNoteSchema = z.object({ body: z.string().trim().min(1).max(4096) });
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
