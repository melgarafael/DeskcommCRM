/**
 * Surrogates online (métricas proxy de alta frequência do flywheel).
 *
 * Cada surrogate é um EVENTO derivável por lead: identificadores (org_id +
 * lead_id, chaves de 1ª classe), timestamp da observação, valor da métrica e a
 * referência de derivação (de qual evento/coluna do CRM veio). A regra de
 * derivação de cada métrica está em docs/surrogates.md.
 *
 * Doutrina (blueprint achado 4.5): surrogates VALIDAM contra a conversão final
 * (correlação periódica), nunca gateiam decisão do flywheel — gate online
 * automático só como guardrail de degradação grosseira.
 *
 * A derivação executável (leitura do event_log/messages do CRM) chega em F2/F5;
 * este módulo é só o contrato.
 */
import { z } from 'zod';

/** Base compartilhada: todo surrogate é observado por lead, dentro de uma org. */
const surrogateBaseSchema = z.object({
  /** `orgs.id` do harness (mapeado do `organization_id` do CRM no pareamento). */
  org_id: z.uuid(),
  /** `leads.id` do harness (espelho por `crm_contact_id`, edge-contract §1). */
  lead_id: z.uuid(),
  /** Quando a observação foi derivada (ISO 8601). */
  observed_at: z.iso.datetime({ offset: true }),
});

/** Lead respondeu: inbound do lead após outbound do agente na mesma conversa. */
export const leadRepliedSchema = surrogateBaseSchema.extend({
  metric: z.literal('lead_replied'),
  source: z.object({
    /** `event_log.id` do `ai_agent.dispatch_requested` que sinalizou o inbound. */
    crm_event_log_id: z.uuid(),
    /** `payload.inbound_message_id` do evento (linha em `messages` do CRM). */
    crm_inbound_message_id: z.uuid(),
  }),
});
export type LeadReplied = z.infer<typeof leadRepliedSchema>;

/** Lead avançou de stage no funil (`crm_leads.stage`). */
export const stageAdvancedSchema = surrogateBaseSchema.extend({
  metric: z.literal('stage_advanced'),
  /** Stage anterior; null quando é a primeira observação do lead no funil. */
  from_stage: z.string().min(1).nullable(),
  to_stage: z.string().min(1),
  source: z.object({
    /** `crm_leads.id` cuja coluna `stage` transicionou. */
    crm_lead_id: z.uuid(),
  }),
});
export type StageAdvanced = z.infer<typeof stageAdvancedSchema>;

/** Lead pediu STOP: transição de `contacts.is_blocked` para true (irrevogável). */
export const stopRequestedSchema = surrogateBaseSchema.extend({
  metric: z.literal('stop_requested'),
  source: z.object({
    /** `contacts.id` do CRM cuja coluna `is_blocked` virou true. */
    crm_contact_id: z.uuid(),
  }),
});
export type StopRequested = z.infer<typeof stopRequestedSchema>;

/** Lead sumiu: sem inbound por N dias após o último outbound do agente. */
export const dropoffSchema = surrogateBaseSchema.extend({
  metric: z.literal('dropoff'),
  /** Dias de silêncio decorridos quando o dropoff foi declarado (N é knob). */
  silence_days: z.number().int().positive(),
  source: z.object({
    /** `messages.id` do último outbound do agente (`sent_via='ai'`) sem resposta. */
    crm_last_outbound_message_id: z.uuid(),
    /** `messages.sent_at` desse outbound — início da janela de silêncio. */
    crm_last_outbound_at: z.iso.datetime({ offset: true }),
  }),
});
export type Dropoff = z.infer<typeof dropoffSchema>;

/** Tempo até resposta: delta entre outbound do agente e o inbound seguinte. */
export const timeToReplySchema = surrogateBaseSchema.extend({
  metric: z.literal('time_to_reply'),
  seconds: z.number().nonnegative(),
  source: z.object({
    /** `messages.id` do outbound do agente que abriu a espera. */
    crm_outbound_message_id: z.uuid(),
    /** `messages.id` do inbound do lead que fechou o delta. */
    crm_inbound_message_id: z.uuid(),
  }),
});
export type TimeToReply = z.infer<typeof timeToReplySchema>;

/** União discriminada por `metric` — o shape que fila/telemetria transportam. */
export const surrogateEventSchema = z.discriminatedUnion('metric', [
  leadRepliedSchema,
  stageAdvancedSchema,
  stopRequestedSchema,
  dropoffSchema,
  timeToReplySchema,
]);
export type SurrogateEvent = z.infer<typeof surrogateEventSchema>;
