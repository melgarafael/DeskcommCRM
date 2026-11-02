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

import { VISIBILITY_MODES as MODOS_DE_VISIBILIDADE } from "@/lib/auth/types";
import { PRAZO_MAX_MINUTOS, PRAZO_MAX_MINUTOS_DEVOLUCAO, PRAZO_MIN_MINUTOS } from "@/lib/escalacao/devolucao-automatica";
import { fusoValido } from "@/lib/tempo/fusos";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Modos de roteamento. `manual` e `round_robin` são o MVP (decisão G1-06b);
 * `load` — o de menor carga, com desempate pelo rodízio — era o "pós-MVP"
 * prometido ali e entrou pela issue #1539. O worker (lib/routing/decide.ts) e
 * as DUAS telas que oferecem o modo (settings/atendimento e team) derivam desta
 * lista, então acrescentar um modo aqui os atualiza sem tocar em mais nada.
 */
export const ROUTING_MODES = ["manual", "round_robin", "load"] as const;
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
   * `lib/escalacao/devolucao-automatica.ts`, e a faixa (5 min – 30 dias)
   * também.
   *
   * SEM teto de 24 h (#3313): o teto antigo recusava, na borda, o prazo que a
   * operação pediu (dias de cotação com fornecedor). O teto largo vive em
   * `PRAZO_MAX_MINUTOS_DEVOLUCAO` e NÃO é o mesmo do silêncio do celular nem
   * o da devolução ao rodízio.
   */
  handoff_return_after_minutes: z
    .number()
    .int()
    .min(PRAZO_MIN_MINUTOS)
    .max(PRAZO_MAX_MINUTOS_DEVOLUCAO)
    .nullable()
    .default(null),
  /**
   * Quantos minutos a IA fica calada numa conversa depois que alguém da equipe
   * responde por FORA do CRM (pelo celular, no próprio aplicativo do canal).
   * `null` = o padrão de 60 min. Cada nova resposta à mão renova o prazo. Quem
   * lê é `lerPrazoDoSilencioManualMinutos` (`lib/escalacao/atendimento-manual.ts`),
   * que trata ausente/fora da faixa como 60. Nasceu do diagnóstico de
   * @gaberaldo-svg (#2005): a clínica que atende o dia inteiro pelo celular
   * renovava os 60 min a cada fala, e a IA não respondia ninguém o dia todo.
   */
  manual_reply_silence_minutes: z
    .number()
    .int()
    .min(PRAZO_MIN_MINUTOS)
    .max(PRAZO_MAX_MINUTOS)
    .nullable()
    .default(null),
  /**
   * Prazo, em minutos, para DEVOLVER AO RODÍZIO a conversa que o rodízio
   * entregou e ninguém respondeu (issue #2985, fatia 1). `null` = desligado — o
   * padrão, para quem já instalou não ver o comportamento mudar. Ligado, o cron
   * `rodizio-devolucao` solta o dono da conversa entregue por `routing` sem
   * nenhuma mensagem humana (`sent_via` `user` ou `external_device`) e devolve a
   * conversa à distribuição; a pessoa devolvida fica fora DESTA conversa por
   * 24 h. A regra pura está em `lib/escalacao/devolucao-ao-rodizio.ts`, e a
   * faixa (5 min – 24 h) é a MESMA da devolução ao agente.
   *
   * A string nova de i18n não existe de propósito: esta fatia não tem tela (é a
   * fatia 2) nem aviso (fatia 3) — nenhum texto novo chega ao usuário.
   */
  unanswered_return_minutes: z
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
 * aqui só se declara a VALIDAÇÃO do input externo, a partir da MESMA lista — a
 * lista literal morava nos dois arquivos e um teste comparava array com array
 * para impedir que divergissem. Agora não há o que divergir.
 */
export const VISIBILITY_MODES = MODOS_DE_VISIBILIDADE;
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
   * roteamento, não pode desligar a devolução automática por omissão. O teto é
   * o LARGO (`PRAZO_MAX_MINUTOS_DEVOLUCAO`, 30 dias), o mesmo do leitor do cron
   * (#3313): schema e leitor divergindo fariam a tela salvar um prazo que o cron
   * descartaria em silêncio.
   */
  handoff_return_after_minutes: z
    .number()
    .int()
    .min(PRAZO_MIN_MINUTOS)
    .max(PRAZO_MAX_MINUTOS_DEVOLUCAO)
    .nullable()
    .optional(),
  /** Opcional pela mesma razão: cliente antigo não desliga o ajuste por omissão. */
  conversation_stays_with_attendant: z.boolean().optional(),
  /** Opcional pela mesma razão: cliente antigo não volta o prazo para 60 por omissão. */
  manual_reply_silence_minutes: z
    .number()
    .int()
    .min(PRAZO_MIN_MINUTOS)
    .max(PRAZO_MAX_MINUTOS)
    .nullable()
    .optional(),
  /**
   * Opcional pela mesma razão: cliente antigo que só conhece o modo de
   * roteamento não pode LIGAR a devolução ao rodízio por omissão. Omitido
   * preserva o que já valia (o padrão é `null`, desligado).
   */
  unanswered_return_minutes: z
    .number()
    .int()
    .min(PRAZO_MIN_MINUTOS)
    .max(PRAZO_MAX_MINUTOS)
    .nullable()
    .optional(),
});
export type AtendimentoConfigPatch = z.infer<typeof atendimentoConfigPatchSchema>;

/**
 * O `settings` da organização depois de um PATCH — a regra num lugar só, para
 * a rota e o teste lerem a MESMA mescla (o teste era uma cópia da rota, e cópia
 * diverge sem avisar).
 *
 * Merge não-destrutivo em DOIS níveis: preserva as demais chaves de `settings`
 * (o provedor de IA mora nele) e, para o que veio OMITIDO do corpo —
 * `visibility_mode`, `handoff_return_after_minutes`, `conversation_stays_with_attendant`,
 * `manual_reply_silence_minutes` e `unanswered_return_minutes` —, preserva o que já
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
    manual_reply_silence_minutes,
    unanswered_return_minutes,
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
    manual_reply_silence_minutes:
      manual_reply_silence_minutes !== undefined
        ? manual_reply_silence_minutes
        : routingAtual.manual_reply_silence_minutes,
    unanswered_return_minutes:
      unanswered_return_minutes !== undefined
        ? unanswered_return_minutes
        : routingAtual.unanswered_return_minutes,
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

/**
 * Setores de atendimento (migration 0801). Os limites são os CHECKs da tabela
 * `attendant_sectors` — o Zod recusa antes, com mensagem para a pessoa, o que o
 * banco recusaria com um erro de constraint.
 */
export const SETOR_NOME_MAX = 60;
export const SETOR_DESCRICAO_MAX = 280;

export const sectorCreateSchema = z
  .object({
    name: z.string().trim().min(1, "Dê um nome ao setor.").max(SETOR_NOME_MAX),
    description: z
      .string()
      .trim()
      .max(SETOR_DESCRICAO_MAX)
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .strict();
export type SectorCreate = z.infer<typeof sectorCreateSchema>;

export const sectorPatchSchema = z
  .object({
    name: z.string().trim().min(1, "Dê um nome ao setor.").max(SETOR_NOME_MAX),
    description: z
      .string()
      .trim()
      .max(SETOR_DESCRICAO_MAX)
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo (name ou description).",
  });
export type SectorPatch = z.infer<typeof sectorPatchSchema>;

/** PUT do setor de um atendente. `null` = tirar do setor ("sem setor"). */
export const sectorAssignmentSchema = z
  .object({ sector_id: z.string().uuid().nullable() })
  .strict();
export type SectorAssignment = z.infer<typeof sectorAssignmentSchema>;

/**
 * Corpo do PATCH de `/api/v1/settings/routing/channels` (regras POR NÚMERO,
 * issue #2331). `distribution_mode` e `default_assignee_user_id` são OPCIONAIS:
 * a tela que só mexe nos responsáveis continua mandando o mesmo corpo, e o
 * número fica sem regra própria (herda a organização). `null` explícito é
 * diferente de omitir na chamada da RPC — a tela manda sempre o que quer gravar.
 */
export const channelRoutingPatchSchema = z.object({
  channel_session_id: z.string().uuid(),
  user_ids: z.array(z.string().uuid()).max(1000),
  reset: z.boolean().default(false),
  distribution_mode: z.enum(ROUTING_MODES).nullable().optional(),
  default_assignee_user_id: z.string().uuid().nullable().optional(),
}).strict();
