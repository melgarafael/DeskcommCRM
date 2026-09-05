/**
 * Zod schemas for /app/settings/* server actions and routes (EPIC-10).
 *
 * - profileSchema: persisted to auth.users.raw_user_meta_data
 * - tenantSchema: persisted to organizations row + organizations.settings jsonb
 * - notificationPrefsSchema: STUB (notification_prefs table not yet migrated)
 * - pipelineConfigPatchSchema: pipeline vocabulary + settings.fields + settings.lost_reasons
 */
import { z } from "zod";

import { ehHexValido } from "@/lib/branding/rampa";
import { IDIOMAS } from "@/lib/i18n/idiomas";
import { MOEDAS_SERVIDAS } from "@/lib/money";

import { conversationTagSchema } from "./messaging";

/**
 * Os idiomas que a interface REALMENTE serve.
 *
 * `en-US` saiu: esteve na lista desde sempre e nunca teve uma linha de
 * tradução — escolhê-lo não mudava nada. Espanhol entrou quando passou a mudar.
 * A fonte é `lib/i18n/idiomas`, para a validação e o dicionário não divergirem:
 * um idioma aceito aqui e desconhecido lá cairia no padrão em silêncio.
 */
const LOCALES = IDIOMAS;

/**
 * G6-02: organizations.settings.ai_dispatch_mode (edge-contract do Vendaval).
 * 'native' (default) = o dispatcher de IA deste repo processa os eventos
 * ai_agent.dispatch_requested. 'external' = o tenant delega o dispatch ao
 * runtime externo (Vendaval); o dispatcher nativo PULA o evento sem tocá-lo.
 * `.catch("native")` normaliza chave ausente/null/inválida para o default seguro.
 */
export const AI_DISPATCH_MODES = ["native", "external"] as const;
export type AiDispatchMode = (typeof AI_DISPATCH_MODES)[number];
export const aiDispatchModeSchema = z.enum(AI_DISPATCH_MODES).catch("native");

/**
 * G3-05: vocabulário canônico de tags de conversa, persistido em
 * organizations.settings.canonical_conversation_tags (spec 13 §3.3 — org-scoped,
 * não pipeline-scoped). Schema declarativo; usado para validar o que o inbox lê
 * como sugestões.
 */
export const canonicalConversationTagsSchema = z
  .array(conversationTagSchema)
  .max(50)
  .transform((tags) => Array.from(new Set(tags)))
  .catch([]);
export type CanonicalConversationTags = z.infer<typeof canonicalConversationTagsSchema>;
export type Locale = (typeof LOCALES)[number];

/**
 * "Sigo minha empresa" — a ausência de preferência, com um valor para ela.
 *
 * Sem isto, quem abrisse o perfil por qualquer motivo (trocar o fuso, o nome)
 * sairia de lá com uma preferência de idioma que nunca escolheu: o seletor
 * mostraria o idioma em vigor e o salvar o gravaria como decisão pessoal. A
 * partir daí, trocar o idioma da empresa não alcançaria mais essa pessoa — e
 * ninguém entenderia por quê.
 */
export const SEM_PREFERENCIA_DE_IDIOMA = "auto";

export const profileSchema = z.object({
  full_name: z.string().min(1).max(120).nullable().optional(),
  locale: z.enum([...LOCALES, SEM_PREFERENCIA_DE_IDIOMA]),
  timezone: z.string().min(1).max(64),
  avatar_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});
export type ProfileInput = z.infer<typeof profileSchema>;

/**
 * As moedas servidas vêm de `lib/money`, pelo mesmo motivo que os idiomas vêm
 * de `lib/i18n/idiomas`: com duas listas, uma moeda aceita aqui e ausente do
 * seletor vira um valor que ninguém consegue mais escolher de volta.
 */
const MOEDAS = MOEDAS_SERVIDAS;

export const tenantSchema = z.object({
  display_name: z.string().min(1).max(120),
  legal_name: z.string().min(1).max(200),
  cnpj: z
    .string()
    .max(20)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  timezone: z.string().min(1).max(64),
  locale: z.enum(LOCALES),
  currency: z.enum(MOEDAS),
  media_retention_days: z.coerce.number().int().min(30).max(3650),
  dpo_email: z
    .string()
    .email()
    .max(200)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  privacy_policy_url: z
    .string()
    .url()
    .max(2048)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  lost_reasons_extra: z.array(z.string().min(1).max(80)).max(50).default([]),
});
export type TenantInput = z.infer<typeof tenantSchema>;

export const NOTIFICATION_CATEGORIES = [
  "lead_assigned",
  "lead_won",
  "lead_lost",
  "mention",
] as const;
export const NOTIFICATION_CHANNELS = ["email", "in_app", "push"] as const;

export const notificationPrefsSchema = z.object({
  prefs: z.array(
    z.object({
      category: z.enum(NOTIFICATION_CATEGORIES),
      channel: z.enum(NOTIFICATION_CHANNELS),
      enabled: z.boolean(),
    }),
  ),
});
export type NotificationPrefsInput = z.infer<typeof notificationPrefsSchema>;

export const customFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/i, "Use letras, números e underscore"),
  label: z.string().min(1).max(80),
  type: z.enum([
    "text",
    "textarea",
    "number",
    "date",
    "select",
    "multiselect",
    "boolean",
    "email",
    "phone",
    "url",
  ]),
  required: z.boolean().optional(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
    .optional(),
});
export type CustomFieldDef = z.infer<typeof customFieldSchema>;

export const pipelineConfigPatchSchema = z.object({
  vocabulary: z
    .object({
      lead: z.string().min(1).max(40).optional(),
      deal: z.string().min(1).max(40).optional(),
      won: z.string().min(1).max(40).optional(),
      lost: z.string().min(1).max(40).optional(),
    })
    .optional(),
  fields: z.array(customFieldSchema).max(50).optional(),
  lost_reasons: z.array(z.string().min(1).max(80)).max(50).optional(),
});
export type PipelineConfigPatch = z.infer<typeof pipelineConfigPatchSchema>;

/**
 * A marca da INSTALAÇÃO (`platform_branding`) — o que a server action aceita.
 *
 * `.nullable()` em cada campo, e não `.optional()`: aqui `null` é um valor com
 * significado ("apague este campo, quero o padrão do produto"), e ausência
 * significaria "não mexa". Colapsar os dois faria a tela não ter como limpar o
 * logo depois de configurá-lo.
 *
 * `accent_hex` valida com `ehHexValido` — o validador do domínio, o MESMO que
 * `lib/branding/schema.ts` usa — e a action normaliza antes de gravar. Um regex
 * novo escrito aqui divergiria do CHECK do banco (`^#[0-9a-f]{6}$`) e o operador
 * receberia um `23514` cru na tela em vez de "essa cor não é válida".
 */
export const platformBrandingSchema = z.object({
  app_name: z.string().trim().min(1).max(120).nullable(),
  logo_url: z.string().trim().url().max(2048).nullable(),
  accent_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .nullable(),
  show_powered_by: z.boolean(),
});
export type PlatformBrandingInput = z.infer<typeof platformBrandingSchema>;

/**
 * A marca da ORGANIZAÇÃO (`organizations.settings.branding`) — o cliente final
 * do revendedor, e o que a Server Action `updateMarcaDaOrganizacao` aceita.
 *
 * `.nullable()` pelo mesmo motivo do schema de cima: aqui `null` é um valor com
 * significado ("apague este campo, quero o que vem da instalação") e ausência
 * significaria "não mexa". Colapsar os dois deixaria o admin sem como voltar
 * atrás depois de escolher uma cor.
 *
 * SEM `logo_url`: upload é a fase seguinte (bucket, policies, limite de tamanho,
 * delete-on-replace). Um campo aqui hoje seria contrato oferecido e não
 * implementado — a precedência por campo garante que o logo da instalação
 * continua valendo enquanto isso.
 *
 * `accent_hex` valida com `ehHexValido` — o MESMO validador do domínio que
 * `lib/branding/schema.ts` usa — e a action normaliza antes de gravar. Um regex
 * novo escrito aqui divergiria da regex da função SQL (`^#[0-9a-f]{6}$`) e o
 * admin receberia um `22023` cru na tela em vez de "essa cor não é válida".
 */
export const marcaDaOrganizacaoSchema = z.object({
  app_name: z.string().trim().min(1).max(120).nullable(),
  accent_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .nullable(),
});
export type MarcaDaOrganizacaoInput = z.infer<typeof marcaDaOrganizacaoSchema>;
