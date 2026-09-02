/**
 * Zod schemas do roteamento de atendimento (G5-01 — spec 13 §3.4/§3.5/§5).
 *
 * - routingConfigSchema: organizations.settings.routing (mode + knobs). Os knobs
 *   (max_retries, backoff_seconds) são CONFIG lida pelo worker de G5-02 — NUNCA
 *   constantes hardcoded no worker (doutrina do repo).
 * - availabilitySchedule: janela tz-aware por atendente ({timezone, windows}).
 * - availabilityPatchSchema: PATCH parcial de attendant_availability.
 */
import { z } from "zod";

import { fusoValido } from "@/lib/tempo/fusos";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Modos de roteamento no MVP (decisão G1-06b); "load" fica pós-MVP. */
export const ROUTING_MODES = ["manual", "round_robin"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/**
 * organizations.settings.routing. Default mode = "manual" (round_robin é opt-in,
 * derivado de G1-06b). Defaults dos knobs = spec 13 §3.5.
 */
export const routingConfigSchema = z.object({
  mode: z.enum(ROUTING_MODES).default("manual"),
  max_retries: z.number().int().min(0).max(20).default(5),
  backoff_seconds: z.number().int().min(1).max(3600).default(60),
});
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

/**
 * `organizations.settings.visibility_mode` — o escopo de leitura do role
 * `agent` em conversas, mensagens e leads (spec 13 §3.5, decisão G1-06a).
 *
 * Mora em `settings.visibility_mode`, IRMÃO de `settings.routing` e não dentro
 * dele: as funções de RLS (`fn_can_view_lead`, `fn_can_view_conversation`) leem
 * esse caminho exato. Aninhar aqui por arrumação quebraria a RLS em silêncio.
 *
 * O tipo canônico é o de `lib/auth/types.ts` (usado pelo layout e pelo inbox);
 * aqui só se declara a validação do input externo. A `satisfies` abaixo é o que
 * impede as duas listas de divergirem sem ninguém notar.
 */
export const VISIBILITY_MODES = ["all", "own_and_unassigned", "own"] as const;
export type VisibilityModeInput = (typeof VISIBILITY_MODES)[number];

/**
 * Corpo do PATCH de `/api/v1/settings/routing`.
 *
 * `visibility_mode` é OPCIONAL de propósito: um cliente que só quer mudar o modo
 * de roteamento continua mandando o mesmo corpo de antes, e a visibilidade fica
 * como está. Mandar `visibility_mode` sem querer mudá-la é o erro que faria uma
 * org perder a restrição por descuido de um cliente antigo.
 */
export const atendimentoConfigPatchSchema = routingConfigSchema.extend({
  visibility_mode: z.enum(VISIBILITY_MODES).optional(),
});
export type AtendimentoConfigPatch = z.infer<typeof atendimentoConfigPatchSchema>;

/** Uma janela de disponibilidade: dow 0=domingo … 6=sábado, "HH:MM"–"HH:MM". */
export const scheduleWindowSchema = z
  .object({
    dow: z.number().int().min(0).max(6),
    start: z.string().regex(HHMM, "start deve ser HH:MM"),
    end: z.string().regex(HHMM, "end deve ser HH:MM"),
  })
  .refine((w) => w.start < w.end, { message: "start deve ser antes de end" });
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;

/**
 * schedule tz-aware. `windows` vazio = sem restrição de horário (24/7) — o
 * default do DB é `{}`, então um atendente recém-criado não fica inelegível por
 * falta de janela; janelas EXISTEM para RESTRINGIR.
 */
export const availabilityScheduleSchema = z.object({
  /**
   * VALIDADO contra o runtime, e não só por tamanho.
   *
   * `localMoment` (lib/routing/eligibility) usa `Intl.DateTimeFormat` com este
   * valor, e o `Intl` LANÇA `RangeError` num fuso que não existe. Antes desta
   * checagem, `z.string().min(1).max(64)` aceitava qualquer coisa: digitar
   * `America/Asunción` — com o acento que um hispanofalante escreve natural —
   * salvava sem reclamar e derrubava a avaliação de disponibilidade de TODO
   * atendente com aquela agenda.
   *
   * O defeito não aparecia na tela que o causava: aparecia no roteamento, como
   * atendente que nunca fica elegível.
   */
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(fusoValido, "fuso horário inválido (ex.: America/Asuncion)")
    .default("Africa/Maputo"),
  windows: z.array(scheduleWindowSchema).max(50).default([]),
});
export type AvailabilitySchedule = z.infer<typeof availabilityScheduleSchema>;

/** PATCH parcial de disponibilidade (o atendente muda a sua; manager, de todos). */
export const availabilityPatchSchema = z
  .object({
    is_available: z.boolean(),
    capacity: z.number().int().min(1).max(1000),
    schedule: availabilityScheduleSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo (is_available, capacity ou schedule).",
  });
export type AvailabilityPatch = z.infer<typeof availabilityPatchSchema>;
