/**
 * Zod schemas for webhook-sources e automation-rules (feature Webhooks, Task 12).
 *
 * `ENTIDADE_ESPERADA_POR_GATILHO`, logo abaixo, é a fonte única dos gatilhos:
 * `lib/automation/engine.ts` e `lib/automation/engine.handler.ts` leem daqui.
 * (Este cabeçalho já afirmou "exatamente os 5 eventos" — número que envelheceu
 * na primeira vez que alguém acrescentou um. Agora não há número a envelhecer.)
 */
import { z } from "zod";

import {
  GATILHO_DE_DATA_DO_FUNIL,
  configDoGatilhoDeData,
} from "@/lib/automation/gatilho-de-data-do-funil";

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
  // A entrega FALHOU depois de aceita — o 131047 que a Meta recusa pelo
  // webhook de status, o timeout do transporte, o pré-voo do próprio envio.
  // Gatilho novo porque quem integra via token não lê o nosso banco (#1614):
  // sem ele, a linha virava `failed` sozinha e o sistema do lado de fora
  // registrava "mensagem enviada" para uma mensagem que nunca chegou.
  "message.failed": "message",
  "lead.tag_added": "crm_lead",
  "contact.tag_added": "contact",
  // O aniversário nasce do cron `contact-birthdays`, e não de uma ação de
  // alguém: a entidade que ele traz é o próprio contato que faz aniversário.
  "contact.birthday": "contact",
  "appointment.created": "calendar_appointment",
  "appointment.confirmed": "calendar_appointment",
  "appointment.rescheduled": "calendar_appointment",
  "appointment.cancelled": "calendar_appointment",
  // Desfecho (#1612): quem acompanha compromisso por webhook precisa saber se a
  // pessoa VEIO — comparecimento e falta não eram gatilho, e a única fonte
  // interna (`appointment.outcome_confirmed`) emite só para falta. Os dois
  // nascem da transição, em `lib/agenda/laco.ts`, e a entidade é a mesma dos
  // irmãos: o motor já sabe hidratar compromisso.
  "appointment.completed": "calendar_appointment",
  "appointment.no_show": "calendar_appointment",
  // O gatilho de DATA do funil (#989) também nasce do relógio, e não de uma
  // ação de alguém — quem o emite é a varredura `lead-date-field-due`, e a
  // entidade que ele traz é o NEGÓCIO dono do campo de data. É `crm_lead`, e
  // não `lead`: é a entidade que os handlers desta feature emitem, e a que o
  // `buildContext` do motor sabe hidratar (o negócio, e o contato dele).
  "lead.date_field_due": "crm_lead",
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
      /**
       * Opt-in do RESPONSÁVEL (#1612, mesma régua proposta em #1528).
       *
       * Sem isto, o corpo não leva quem atende — nem `owner_user_id`, nem nome.
       * O compromisso é dado interno do estúdio: quem integra pediu horário,
       * status e tipo, não a identidade da equipe. Vazar por padrão seria
       * transformar um dado protegido em detalhe acidental de payload; só sai
       * quando quem monta a regra pede, na cara, na tela.
       */
      include_owner: z.boolean().optional(),
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

export const createAutomationRuleSchema = z
  .object({
    name: z.string().min(1).max(120),
    trigger_event: z.enum(TRIGGER_EVENTS),
    conditions: z.array(conditionSchema).max(10).default([]),
    actions: z.array(actionSchema).min(1).max(10),
    /**
     * O que o gatilho precisa saber além do nome dele (#989).
     *
     * Só o gatilho de DATA do funil usa: o campo de data é de UM funil
     * (`pipelines.settings.fields`), então a regra guarda funil + campo + N. Os
     * outros gatilhos nascem de um evento que já traz tudo, e seguem com o
     * objeto vazio.
     */
    trigger_config: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine(exigirConfigDoGatilhoDeData);

/**
 * O gatilho de data sem a configuração dele é uma regra que NUNCA dispara — a
 * varredura não sabe onde olhar. Recusar na porta é o único desfecho honesto:
 * aceitar calado produziria a tela dizendo "salvo" e o operador esperando.
 */
function exigirConfigDoGatilhoDeData(
  regra: { trigger_event: string; trigger_config?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  if (regra.trigger_event !== GATILHO_DE_DATA_DO_FUNIL) return;
  if (configDoGatilhoDeData(regra.trigger_config)) return;
  ctx.addIssue({
    code: "custom",
    path: ["trigger_config"],
    message: "Escolha o funil, o campo de data e em quantos dias avisar.",
  });
}

export const updateAutomationRuleSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    trigger_event: z.enum(TRIGGER_EVENTS).optional(),
    conditions: z.array(conditionSchema).max(10).optional(),
    actions: z.array(actionSchema).min(1).max(10).optional(),
    trigger_config: z.record(z.string(), z.unknown()).optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((patch, ctx) => {
    // O PATCH que troca o gatilho PARA o de data, sem mandar a configuração,
    // deixaria a regra existindo e jamais disparando — mesmo defeito da criação,
    // pela porta do lado.
    if (patch.trigger_event !== GATILHO_DE_DATA_DO_FUNIL) return;
    if (configDoGatilhoDeData(patch.trigger_config)) return;
    ctx.addIssue({
      code: "custom",
      path: ["trigger_config"],
      message: "Escolha o funil, o campo de data e em quantos dias avisar.",
    });
  });

export type CreateWebhookSourceInput = z.infer<typeof createWebhookSourceSchema>;
export type UpdateWebhookSourceInput = z.infer<typeof updateWebhookSourceSchema>;
export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
