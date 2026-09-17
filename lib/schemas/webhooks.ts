/**
 * Zod schemas for webhook-sources e automation-rules (feature Webhooks, Task 12).
 *
 * `ENTIDADE_ESPERADA_POR_GATILHO`, logo abaixo, é a fonte única dos gatilhos:
 * `lib/automation/engine.ts` e `lib/automation/engine.handler.ts` leem daqui.
 * (Este cabeçalho já afirmou "exatamente os 5 eventos" — número que envelheceu
 * na primeira vez que alguém acrescentou um. Agora não há número a envelhecer.)
 */
import { z } from "zod";

/**
 * Os gatilhos que o motor reconhece, e a entidade que cada um tem que trazer.
 *
 * É UMA FONTE, e não três, porque as três divergiam: este arquivo listava os
 * gatilhos para o Zod, `engine.ts` repetia o mapa de entidade, e
 * `engine.handler.ts` repetia a lista de novo para se registrar no dispatcher.
 * Acrescentar um gatilho exigia lembrar dos três lugares, e esquecer o terceiro
 * produz o pior desfecho possível: a regra aparece na tela, o operador a salva,
 * o evento acontece — e nada roda, porque o handler não assinou aquele evento.
 * Sem erro, sem log, sem run.
 *
 * A entidade existe porque o trigger legado `fn_emit_event_on_lead_change` emite
 * `lead.created` com `entity_kind='lead'` (derivado por `split_part` do
 * event_type) enquanto os handlers desta feature emitem `crm_lead`. Sem o guard,
 * o motor rodaria a regra duas vezes por mudança de lead.
 */
export const ENTIDADE_ESPERADA_POR_GATILHO = {
  "lead.created": "crm_lead",
  "lead.stage_changed": "crm_lead",
  "message.received": "message",
  "lead.tag_added": "crm_lead",
  "contact.tag_added": "contact",
  // O aniversário nasce do cron `contact-birthdays`, e não de uma ação de
  // alguém: a entidade que ele traz é o próprio contato que faz aniversário.
  "contact.birthday": "contact",
  "appointment.created": "calendar_appointment",
  "appointment.confirmed": "calendar_appointment",
  "appointment.rescheduled": "calendar_appointment",
  "appointment.cancelled": "calendar_appointment",
} as const;

export type GatilhoDeAutomacao = keyof typeof ENTIDADE_ESPERADA_POR_GATILHO;

export const TRIGGER_EVENTS = Object.keys(ENTIDADE_ESPERADA_POR_GATILHO) as [
  GatilhoDeAutomacao,
  ...GatilhoDeAutomacao[],
];

export const conditionSchema = z.object({
  field: z.string().min(1).max(200),
  op: z.enum(["eq", "neq", "contains"]),
  value: z.string().max(500),
});

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_or_move_lead"), config: z.object({ pipeline_id: z.string().uuid(), stage_id: z.string().uuid() }) }),
  z.object({ type: z.literal("send_whatsapp_message"), config: z.object({ channel_session_id: z.string().uuid(), template: z.string().min(1).max(2000) }) }),
  z.object({ type: z.literal("add_tag"), config: z.object({ tags: z.array(z.string().min(1).max(60)).min(1).max(10) }) }),
  z.object({ type: z.literal("assign_owner"), config: z.object({ user_id: z.string().uuid() }) }),
  z.object({
    type: z.literal("send_ai_message"),
    config: z.object({
      /** Agente PUBLICADO que assina a mensagem. */
      agent_id: z.string().uuid(),
      channel_session_id: z.string().uuid(),
      /**
       * O que fazer com os dados do formulário. Mesmo teto do `prompt_hint` de
       * um passo de follow-up (1000): é instrução, não roteiro — quem escreve
       * mais que isso está tentando pôr o prompt do agente aqui dentro.
       */
      instruction: z.string().min(1).max(1000),
    }),
  }),
  z.object({
    type: z.literal("call_webhook"),
    config: z.object({
      url: z.string().url().max(2000),
      // Input do usuário (plaintext, write-only) — a rota troca por secret_enc.
      secret: z.string().max(200).optional(),
      // Ciphertext hex (round-trip do editor: GET devolve, PATCH preserva).
      secret_enc: z.string().max(4000).optional(),
    }),
  }),
  z.object({
    type: z.literal("start_message_flow"),
    config: z.object({ flow_pointer_id: z.string().uuid() }),
  }),
]);

export const createWebhookSourceSchema = z.object({
  name: z.string().min(1).max(120),
  default_pipeline_id: z.string().uuid(),
  default_stage_id: z.string().uuid(),
  redirect_to: z.string().url().max(2000).nullish(),
  field_map: z
    .object({
      name: z.array(z.string()).optional(),
      phone: z.array(z.string()).optional(),
      email: z.array(z.string()).optional(),
    })
    .optional(),
  secret: z.string().min(16).max(200).nullish(),
});
export const updateWebhookSourceSchema = createWebhookSourceSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export const createAutomationRuleSchema = z.object({
  name: z.string().min(1).max(120),
  trigger_event: z.enum(TRIGGER_EVENTS),
  conditions: z.array(conditionSchema).max(10).default([]),
  actions: z.array(actionSchema).min(1).max(10),
});
export const updateAutomationRuleSchema = createAutomationRuleSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export type CreateWebhookSourceInput = z.infer<typeof createWebhookSourceSchema>;
export type UpdateWebhookSourceInput = z.infer<typeof updateWebhookSourceSchema>;
export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
