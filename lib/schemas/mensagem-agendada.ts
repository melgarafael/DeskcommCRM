/**
 * Schema do corpo do agendamento de mensagem (#3118).
 *
 * ⚠️ Este é o gate de FORMA (tipos, uuid, tamanho de string). A régua de NEGÓCIO
 * — piso de 30 s, teto de um ano, fuso IANA, teto de partes, texto de 4096 — vive
 * em `lib/mensagem-agendada/regras.ts`, e é a MESMA que o MCP e o worker leem.
 * Duplicar os números aqui criaria a terceira lista que se separa das outras
 * duas: foi o defeito do #3434.
 */
import { z } from "zod";

const parteSchema = z.object({
  body: z.string().max(100_000).nullish(),
  media_storage_path: z.string().max(1_024).nullish(),
  media_mime: z.string().max(200).nullish(),
  media_size_bytes: z.number().int().positive().nullish(),
});

export const agendarMensagemSchema = z
  .object({
    conversation_id: z.string().uuid().nullish(),
    contact_id: z.string().uuid().nullish(),
    scheduled_for: z.string().min(1).max(64),
    tz: z.string().max(64).nullish(),
    cancel_if_contact_replies: z.boolean().optional(),
    parts: z.array(parteSchema).min(1).max(50),
  })
  .refine((v) => v.conversation_id != null || v.contact_id != null, {
    message: "informe conversation_id ou contact_id",
    path: ["conversation_id"],
  });

export type AgendarMensagemInput = z.infer<typeof agendarMensagemSchema>;

export const editarMensagemSchema = z.object({
  scheduled_for: z.string().min(1).max(64).optional(),
  tz: z.string().max(64).nullish(),
  cancel_if_contact_replies: z.boolean().optional(),
  parts: z.array(parteSchema).min(1).max(50).optional(),
});

export type EditarMensagemInput = z.infer<typeof editarMensagemSchema>;
