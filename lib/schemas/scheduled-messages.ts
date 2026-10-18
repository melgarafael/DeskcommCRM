import { z } from "zod";

import { messageTypeSchema } from "@/lib/schemas/messaging";

export const createScheduledMessageSchema = z
  .object({
    send_at: z.string().datetime({ offset: true }),
    type: messageTypeSchema.default("text"),
    body: z.string().min(1).max(4096).optional(),
    media_url: z.string().url().optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    reply_to_message_id: z.string().uuid().optional(),
  })
  .refine(
    (d) =>
      !!d.body ||
      !!d.media_url ||
      !!d.media_storage_path ||
      !!(d.metadata && (d.metadata.shared_contact_id || d.metadata.shared_contact)),
    { message: "Informe texto, mídia ou contato." },
  )
  .refine((d) => new Date(d.send_at).getTime() > Date.now() + 30_000, {
    message: "Agende para pelo menos 30 segundos no futuro.",
    path: ["send_at"],
  });

export type CreateScheduledMessageInput = z.infer<typeof createScheduledMessageSchema>;
