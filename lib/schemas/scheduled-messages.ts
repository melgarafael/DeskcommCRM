import { z } from "zod";

import { messageTypeSchema } from "@/lib/schemas/messaging";

/**
 * Aceita ISO com offset OU datetime-local (`YYYY-MM-DDTHH:mm`), convertendo
 * o segundo para ISO no fuso do servidor (o cliente já manda ISO; isto é rede
 * de segurança contra clientes que mandam o valor cru do input).
 */
function normalizarSendAt(valor: string): string {
  const v = valor.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    return new Date(v).toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (m) {
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      0,
      0,
    );
    return d.toISOString();
  }
  return v;
}

export const createScheduledMessageSchema = z
  .object({
    send_at: z.string().min(1).transform(normalizarSendAt),
    type: messageTypeSchema.default("text"),
    body: z.string().min(1).max(4096).optional(),
    media_url: z.string().url().optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    reply_to_message_id: z.string().uuid().optional(),
    /** Conversa fica pending após o envio até o contato responder. */
    atendimento_oculto: z.boolean().optional().default(false),
  })
  .refine(
    (d) =>
      !!d.body ||
      !!d.media_url ||
      !!d.media_storage_path ||
      !!(d.metadata && (d.metadata.shared_contact_id || d.metadata.shared_contact)),
    { message: "Informe texto, mídia ou contato." },
  )
  .refine((d) => !Number.isNaN(new Date(d.send_at).getTime()), {
    message: "Data/hora inválida.",
    path: ["send_at"],
  })
  .refine((d) => new Date(d.send_at).getTime() > Date.now() + 60_000, {
    message: "Agende para pelo menos 1 minuto no futuro.",
    path: ["send_at"],
  });

export type CreateScheduledMessageInput = z.infer<typeof createScheduledMessageSchema>;
