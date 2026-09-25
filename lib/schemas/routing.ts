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

import { PRAZO_MAX_MINUTOS, PRAZO_MIN_MINUTOS } from "@/lib/escalacao/devolucao-automatica";
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
  /**
   * Prazo, em minutos, para devolver ao agente de IA uma conversa que ficou
   * com uma pessoa e não teve mais nenhum sinal dela. `null` = nunca — a regra
   * IA-06 de sempre (o bot não reassume até alguém clicar "Devolver"), que é o
   * padrão para não mudar o comportamento de quem já instalou. Quem devolve é
   * o cron `handoff-devolucao`; a regra pura está em
   * `lib/escalacao/devolucao-automatica.ts`, e a faixa (5 min – 24 h) também.
   */
  handoff_return_after_minutes: z
    .number()
    .int()
    .min(PRAZO_MIN_MINUTOS)
    .max(PRAZO_MAX_MINUTOS)
    .nullable()
    .default(null),
  /**
   * "A conversa fica com quem atendeu" (ideia de @gustavorodcruz96, #1527).
   * Desligado = o comportamento de sempre: a resposta humana cala a IA por
   * alguns minutos e a conversa encerrada que recebe mensagem nova volta para a
   * fila e para o roteamento. Ligado: responder pelo Inbox numa conversa sem
   * dono a assume (a IA fica calada até alguém devolver), e a conversa
   * encerrada volta direto para o último atendente, se ele ainda é da equipe.
   *
   * ⚠️ O BANCO LÊ ESTE CAMINHO EXATO: `fn_service_inbound` (migration 0396)
   * compara `settings->'routing'->'conversation_stays_with_attendant'` com o
   * booleano `true`. Renomear ou mover a chave desliga a reabertura em silêncio.
   * No TypeScript, quem lê é `conversaFicaComQuemAtendeu()`, com a mesma régua.
   */
  conversation_stays_with_attendant: z.boolean().default(false),
});
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

/**
 * Lê o ajuste "a conversa fica com quem atendeu" sem nunca lançar.
 *
 * A régua é a MESMA do banco: só o booleano `true` liga. Qualquer outra coisa
 * (chave ausente, `"true"` em texto, outra chave de `routing` inválida ao lado)
 * é desligado — o padrão de toda empresa que nunca abriu a tela.
 */
export function conversaFicaComQuemAtendeu(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const routing = (settings as Record<string, unknown>).routing;
  if (!routing || typeof routing !== "object") return false;
  return (routing as Record<string, unknown>).conversation_stays_with_attendant === true;
}

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
  /**
   * Opcional pela MESMA razão de `visibility_mode`: a rota preserva o prazo em
   * vigor quando a chave não vem — um cliente antigo, que só conhece o modo de
   * roteamento, não pode desligar a devolução automática por omissão.
   */
  handoff_return_after_minutes: z
    .number()
    .int()
    .min(PRAZO_MIN_MINUTOS)
    .max(PRAZO_MAX_MINUTOS)
    .nullable()
    .optional(),
  /** Opcional pela mesma razão: cliente antigo não desliga o ajuste por omissão. */
  conversation_stays_with_attendant: z.boolean().optional(),
});
export type AtendimentoConfigPatch = z.infer<typeof atendimentoConfigPatchSchema>;

/**
 * O `settings` da organização depois de um PATCH — a regra num lugar só, para
 * a rota e o teste lerem a MESMA mescla (o teste era uma cópia da rota, e cópia
 * diverge sem avisar).
 *
 * Merge não-destrutivo em DOIS níveis: preserva as demais chaves de `settings`
 * (o provedor de IA mora nele) e, para o que veio OMITIDO do corpo —
 * `visibility_mode` e `handoff_return_after_minutes` —, preserva o que já
 * valia. Um cliente antigo, que só conhece o modo de roteamento, não pode
 * desligar a restrição de visibilidade nem a devolução automática por omissão.
 */
export function mesclarSettingsDeAtendimento(
  atual: Record<string, unknown>,
  input: AtendimentoConfigPatch,
): { settings: Record<string, unknown>; routing: RoutingConfig } {
  const {
    visibility_mode,
    handoff_return_after_minutes,
    conversation_stays_with_attendant,
    ...routingInput
  } = input;
  const routingAtual = routingConfigSchema
    .catch(routingConfigSchema.parse({}))
    .parse(atual.routing ?? {});
  const routing: RoutingConfig = {
    ...routingInput,
    handoff_return_after_minutes:
      handoff_return_after_minutes !== undefined
        ? handoff_return_after_minutes
        : routingAtual.handoff_return_after_minutes,
    conversation_stays_with_attendant:
      conversation_stays_with_attendant ?? routingAtual.conversation_stays_with_attendant,
  };
  const settings: Record<string, unknown> = { ...atual, routing };
  if (visibility_mode !== undefined) settings.visibility_mode = visibility_mode;
  return { settings, routing };
}

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
    .default("America/Sao_Paulo"),
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

export const channelRoutingPatchSchema = z.object({
  channel_session_id: z.string().uuid(),
  user_ids: z.array(z.string().uuid()).max(1000),
  reset: z.boolean().default(false),
}).strict();
