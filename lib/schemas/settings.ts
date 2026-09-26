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
  /**
   * O país da organização (issue #1033): ISO-3166 alpha-2, maiúsculas, `null` =
   * Brasil. É a MESMA régua do CHECK `organizations_country_check` da migration
   * 0277 — a validação de aplicação e a do banco não podem divergir, ou a tela
   * aceita o que o banco recusa (e o erro chega como 500 em vez de formulário).
   * Aqui NÃO se valida se o país tem perfil revisado: quem oferece a lista é
   * `paisesOferecidos()` (`lib/legal/perfil-do-pais.ts`), e o valor que chega é
   * conferido contra ela um degrau antes de gravar — país sem lei revisada não
   * entra nem por API.
   */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
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
  /**
   * QUANDO este campo passa a OBRIGAR (issue #1536).
   *
   * `required` continua com o significado antigo (destaca o campo no formulário);
   * quem barra um movimento de etapa ou um encerramento é SÓ isto aqui — um funil
   * sem `obrigatorio_em` se comporta exatamente como se comportava antes.
   *
   * - `etapas`: etapas do funil nas quais entrar já exige o valor preenchido;
   * - `ao_ganhar`: exigido quando a escrita fecha o negócio como ganho;
   * - `ao_perder`: exigido quando a escrita o deixa perdido.
   *
   * A decisão é do servidor (`lib/leads/campos-exigidos.ts`), não do schema: o
   * schema só diz o que PODE ser exigido, e uma lista vazia significa "nunca".
   */
  obrigatorio_em: z
    .object({
      etapas: z.array(z.string().uuid()).max(50).optional(),
      ao_ganhar: z.boolean().optional(),
      ao_perder: z.boolean().optional(),
    })
    .optional(),
  options: z
    .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
    .optional(),
});
export type CustomFieldDef = z.infer<typeof customFieldSchema>;

/** Os campos que a retomada de negócio encerrado pode copiar (issue #1538). */
export const CAMPOS_COPIAVEIS_NA_RETOMADA = [
  "custom_fields",
  "tags",
  "description",
  "value_cents",
  "currency",
  "expected_close_date",
  "owner_user_id",
  "owner_agent_id",
] as const;

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
  /**
   * O MOTIVO DE GANHO por funil (issue #1536) — espelho de `lost_reasons`.
   * Sem lista cadastrada o motivo é texto livre; com lista, só o que está nela
   * passa (`recusaDeMotivoDoGanho`, o equivalente do ganho à CHECK que o banco
   * já tem para a perda — para o ganho não há trigger, então quem aplica é aqui).
   */
  won_reasons: z.array(z.string().min(1).max(80)).max(50).optional(),
  /** Obrigatóriedade do motivo de ganho, opt-in por funil (padrão: não exigir). */
  won_reason_required: z.boolean().optional(),
  /**
   * O que acontece quando um negócio ENCERRADO volta (issue #1538). Ausente é
   * `mesmo_registro`, o comportamento de antes: reabre o mesmo negócio. Com
   * `novo_negocio`, mover o encerrado para etapa aberta é recusado e a saída é
   * a retomada (`lib/leads/reabertura.ts`).
   */
  reabertura: z.enum(["mesmo_registro", "novo_negocio"]).optional(),
  /** O que a retomada copia da origem; ausente é o piso (`custom_fields` e tags). */
  reabertura_campos: z.array(z.enum(CAMPOS_COPIAVEIS_NA_RETOMADA)).max(8).optional(),
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

/** Prazos por organização. Leitura legada degrada; escrita usa schema estrito. */
export const agendaSettingsWriteSchema = z.strictObject({
  confirmation_delay_minutes: z.number().int().min(1).max(10080),
  unknown_protection_minutes: z.number().int().min(1).max(10080),
  /**
   * Quanto tempo um pedido não confirmado segura o horário.
   *
   * ⚠️ `.default()` e não obrigatório: este schema é `strictObject`, e torná-lo
   * exigido faria TODO PATCH já escrito (que manda só os dois campos de cima)
   * passar a falhar — o tipo de mudança que a doutrina de packaging proíbe,
   * porque quebra quem já instalou sem nenhum aviso.
   *
   * 24h é o default porque quem confere a fila uma vez por dia não pode perder
   * pedido. O mínimo é 15 minutos: abaixo disso a expiração corre com quem está
   * decidindo naquele instante.
   */
  pending_expires_after_minutes: z.number().int().min(15).max(10080).default(1440),
}).refine(v => v.unknown_protection_minutes >= v.confirmation_delay_minutes, {message:"O prazo de proteção deve ser maior que o prazo de confirmação."});
export const agendaSettingsSchema = agendaSettingsWriteSchema.catch({confirmation_delay_minutes:10,unknown_protection_minutes:1440,pending_expires_after_minutes:1440});

/**
 * `organizations.settings.crm` — regras de CRM que cada organização liga para si.
 *
 * `cliente_pela_agenda`: quem tem horário marcado vira cliente (migration 0262).
 * Nasce DESLIGADA em toda organização, e só um administrador a liga, por
 * `fn_definir_cliente_pela_agenda` (nunca por UPDATE em `organizations`).
 *
 * ⚠️ SÓ O BOOLEANO `true` LIGA — e é a mesma régua do banco, que compara
 * `settings->'crm'->'cliente_pela_agenda' = 'true'::jsonb` em
 * `fn_marcar_contato_como_cliente`. Ausente, `false`, a string `"true"` ou
 * qualquer lixo é desligado aqui E lá. Se os dois idiomas divergissem, a tela
 * mostraria o selo de uma regra que o trigger não aplica.
 */
export const crmSettingsSchema = z
  .object({ cliente_pela_agenda: z.boolean().catch(false) })
  .catch({ cliente_pela_agenda: false });

/** A regra "cliente pela agenda" está ligada nesta organização? Nunca lança. */
export function clientePelaAgendaLigado(settings: unknown): boolean {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  return crmSettingsSchema.parse(crm ?? {}).cliente_pela_agenda === true;
}

/**
 * A OPÇÃO "ATENDENTES PODEM MEXER NA AGENDA DOS COLEGAS" (migration 0343,
 * issue #978) — a agenda como opção POR ORGANIZAÇÃO, LIGADA POR PADRÃO.
 *
 * Com ela DESLIGADA, o Atendente só mexe no compromisso de que é dono; Gerente
 * e Administrador seguem mexendo em tudo. Ligada, tudo é como sempre foi.
 *
 * ⚠️ A RÉGUA É "SÓ O `false` EXPLÍCITO DESLIGA", e é a MESMA do banco, que lê
 * `(settings->'colegas_podem_mexer_na_agenda') is distinct from 'false'::jsonb`
 * em `fn_colegas_podem_mexer_na_agenda`. Ausente — toda organização que já
 * existia antes desta migration —, `true`, a string `"true"` ou qualquer lixo
 * contam como LIGADO aqui e lá. É o que faz "padrão ligado" ser literalmente
 * "quem já instalou não vê mudança nenhuma". Se as duas réguas divergissem, a
 * tela mostraria desligada uma regra que o banco aplica — ou o contrário.
 *
 * ⚠️ NÃO mora em `settings.agenda`, e isso é decisão, não acaso:
 * `fn_agenda_settings` SUBSTITUI o objeto `settings.agenda` inteiro e recusa
 * chave que não sejam as duas que ele conhece, então a chave seria recusada por
 * ele e apagada na primeira vez que um Gerente salvasse os prazos. Chave
 * própria de topo, no mesmo espírito do `settings.crm` da migration 0262.
 *
 * Nunca lança: a tela mostra a regra que o banco aplica, e um jsonb torto não
 * pode derrubar Configurações.
 */
export function colegasPodemMexerNaAgendaLigado(settings: unknown): boolean {
  const raiz =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : undefined;
  return raiz?.colegas_podem_mexer_na_agenda !== false;
}
