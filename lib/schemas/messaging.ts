/**
 * Schemas Zod do EPIC-03 Inbox + Messaging.
 *
 * Cobre boundary de validação das rotas /api/v1/conversations e
 * /api/v1/messages. Validações compartilhadas entre rota REST e webhooks
 * (quando o payload entra na pipeline pós-verificação HMAC).
 */
import { z } from "zod";

export const conversationStatusSchema = z.enum([
  "open",
  "claimed",
  "ai_handling",
  "closed",
  "archived",
]);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);

export const messageTypeSchema = z.enum([
  "text",
  "image",
  "audio",
  "document",
  "sticker",
  "video",
  "location",
  "contact",
  // Envio de template aprovado (canal oficial, fora da janela de 24h). Não é
  // "texto com outro nome": o tipo é o que carrega custo, conformidade de janela e
  // o que o contato de fato viu (cabeçalho, rodapé, botões).
  "template",
]);

export const messageStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const sendMessageSchema = z
  .object({
    conversation_id: z.string().uuid(),
    type: messageTypeSchema.default("text"),
    body: z.string().min(1).max(4096).optional(),
    media_url: z.string().url().optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** Só em `type: "template"`. Nome exato aprovado na Meta. */
    template_name: z.string().min(1).max(512).optional(),
    /** Só em `type: "template"`. `pt_BR` e `pt` são templates DISTINTOS. */
    template_language: z.string().min(2).max(16).optional(),
    /**
     * Só em `type: "template"`. Valor por slot, chaveado por `slotKey`
     * (`lib/channels/meta/build-components.ts`) — a MESMA função que o formulário
     * da tela usa. Chave montada de outro jeito é o mismatch voltando.
     */
    template_values: z.record(z.string(), z.string()).optional(),
    /**
     * A mensagem que esta responde — o id da NOSSA linha, não o do provider.
     *
     * Quem envia conhece o que está na tela, e na tela está o nosso id. A
     * tradução para o id que a plataforma entende (`wamid`) é feita no handler,
     * lendo a linha apontada: pedir o `wamid` aqui obrigaria a tela a conhecer
     * o vocabulário do canal, que é justamente o que o seam existe para evitar.
     */
    reply_to_message_id: z.string().uuid().optional(),
  })
  .refine(
    (d) => {
      if (d.type === "contact") {
        const id = d.metadata?.shared_contact_id;
        if (typeof id === "string" && id.length > 0) return true;
        const sc = d.metadata?.shared_contact;
        if (sc && typeof sc === "object" && !Array.isArray(sc)) {
          const phone = (sc as Record<string, unknown>).phone_number;
          return typeof phone === "string" && phone.trim().length >= 8;
        }
        return false;
      }
      return !!d.body || !!d.media_url || !!d.media_storage_path;
    },
    {
      message:
        "body, media_url, media_storage_path, metadata.shared_contact_id or metadata.shared_contact.phone_number required",
      path: ["body"],
    },
  );

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const claimConversationSchema = z.object({
  expected_assignee: z.string().uuid().nullable().optional(),
});

export type ClaimConversationInput = z.infer<typeof claimConversationSchema>;

/** G3-01: transferência imediata (decisão G1-06d) — reatribui com motivo opcional. */
export const transferConversationSchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type TransferConversationInput = z.infer<typeof transferConversationSchema>;

export const updateConversationStatusSchema = z.object({
  status: conversationStatusSchema,
});

export type UpdateConversationStatusInput = z.infer<typeof updateConversationStatusSchema>;

/**
 * G3-05: normalização reutilizável de tag (mesmo shape de contacts.tags /
 * crm_leads.tags — text[]). trim + lowercase; 1..40 chars por tag.
 */
export const conversationTagSchema = z.string().trim().toLowerCase().min(1).max(40);

/** ≤20 tags, deduplicadas após normalização. */
export const conversationTagsSchema = z
  .array(conversationTagSchema)
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));

export type ConversationTags = z.infer<typeof conversationTagsSchema>;

/** G3-05: PATCH /conversations/[id] aceita status e/ou tags (ao menos um). */
export const patchConversationSchema = z
  .object({
    status: conversationStatusSchema.optional(),
    tags: conversationTagsSchema.optional(),
  })
  .refine((d) => d.status !== undefined || d.tags !== undefined, {
    message: "Informe status ou tags.",
  });

export type PatchConversationInput = z.infer<typeof patchConversationSchema>;

/** POST /conversations/open-with-contact — abrir inbox a partir de cartão de contato. */
export const openConversationWithContactSchema = z
  .object({
    channel_session_id: z.string().uuid(),
    contact_id: z.string().uuid().optional(),
    phone_number: z.string().min(8).max(32).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((d) => !!d.contact_id || !!d.phone_number?.trim(), {
    message: "Informe contact_id ou phone_number.",
  });

export type OpenConversationWithContactInput = z.infer<typeof openConversationWithContactSchema>;

/**
 * Estados TERMINAIS: a conversa acabou e não volta sozinha.
 *
 * Vive aqui, e não espalhado em cada `.not(...)`, porque "acabou" é uma decisão
 * de produto — se um dia `resolved` deixar de ser legado e passar a valer, o
 * lugar de dizer isso é um só.
 */
export const CONVERSATION_TERMINAL_STATUSES = ["closed", "archived"] as const;

export const listConversationsQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  /**
   * Esconde as conversas terminais (fechada/arquivada).
   *
   * Existe porque "Minhas" filtrava SÓ por dono e `Fechar` não solta o dono
   * (de propósito: quem atendeu é histórico que vale). Sem isto, tudo que o
   * atendente já fechou ficava na aba dele para sempre, e ela deixava de
   * significar "meu trabalho" para virar "tudo que já toquei".
   */
  exclude_finished: z.boolean().optional(),
  assigned_to: z.union([z.string().uuid(), z.literal("me"), z.literal("unassigned")]).optional(),
  channel_session_id: z.string().uuid().optional(),
  tag: conversationTagSchema.optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
