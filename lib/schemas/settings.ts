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
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { IDIOMAS } from "@/lib/i18n/idiomas";
import { DIAS_MAXIMO_DO_RECORTE } from "@/lib/kanban/recorte-de-encerrados";
import {
  ICONES_DE_ATALHO,
  MAX_ATALHOS,
  modeloAceito,
  TAMANHO_MAXIMO_DO_MODELO,
  TAMANHO_MAXIMO_DO_ROTULO,
} from "@/lib/leads/atalhos-do-card";
import { MOEDAS_SERVIDAS } from "@/lib/money";

import { conversationTagSchema } from "./messaging";
import { mostrarQuandoSchema } from "./mostrar-quando";

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
  /**
   * Interruptor da limpeza automática de mídia antiga (issue #1534, migration
   * 0557). `true` é o padrão do banco, para a organização que já existia e para
   * a nova: a limpeza roda desde a 0432. Quem desliga é a tela; quem aplica é a
   * função do banco. Sem este campo a tela prometeria o que a coluna não grava.
   */
  media_retention_enforced: z.boolean(),
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
    "currency",
    "date",
    "select",
    "multiselect",
    "searchable_select",
    "boolean",
    "email",
    "phone",
    "url",
    "file",
  ]),
  required: z.boolean().optional(),
  /**
   * A QUE PERTENCE O CAMPO (issue #2791): ao NEGÓCIO (`negocio`) ou ao CONTATO
   * (`contato`).
   *
   * A AUSÊNCIA é `negocio` — o comportamento de sempre: toda definição que já
   * existe aparece no card e no dossiê do negócio e é gravada em
   * `crm_leads.custom_fields`. `contato` tira o campo do card e o leva para a
   * ficha do contato, cujo valor mora em `contacts.custom_fields`.
   *
   * Sem `.default()` de propósito: gravar `negocio` em cima de um funil que não
   * tem a chave faria toda definição existente mudar de forma ao salvar (o
   * `handleSave` regrava `fields` inteiro). A ausência é LIDA como `negocio` em
   * `lib/leads/campos-do-funil.ts`, e a tela só escreve a chave quando é
   * `contato`.
   */
  escopo: z.enum(["negocio", "contato"]).optional(),
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
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
        /**
         * APELIDOS da opção (issue #2521): outras grafias que devem casar com
         * ela. `Nova York` ← `New York`, `NY`, `NYC`. Alimentam a busca e a
         * normalização do `searchable_select` (iguais a `value`/`label`, sem
         * caixa, acento nem espaço a mais). Opcional e ausente por padrão — a
         * lista de quem só digitou valores continua idêntica à de antes.
         */
        aliases: z.array(z.string().min(1).max(80)).max(20).optional(),
      }),
    )
    .optional(),
  /**
   * QUANDO este campo aparece (issue #2728) — "mostrar só quando outro tem
   * determinado valor".
   *
   * A condição é montada no editor de campos do funil (campo + operador +
   * valor) e lida por `lib/schemas/mostrar-quando.ts`, que os quatro pontos de
   * renderização consultam. Esconder NÃO apaga valor: quem filtra é a lista
   * que a tela renderiza, e o `custom_fields` gravado segue intacto.
   *
   * Ausente é o caminho de todo funil instalado hoje — a régua continua
   * opt-in, igual a `obrigatorio_em`.
   */
  mostrar_quando: mostrarQuandoSchema.optional(),
  /**
   * O FORMATO que o valor tem de ter (issue #2730): regex em string, na grafia
   * do `pipeline.settings.fields` — `"^\\d{1,2}(,\\d{1,2})*$"` por exemplo.
   *
   * Opcional e SEM refinamento aqui de propósito. `camposDoFunil` lê esta
   * definição com `safeParse` e DESCARTE o campo que não passa: se este schema
   * passasse a exigir regex compilável, um `padrao` quebrado apagaria o campo
   * inteiro da tela em vez de bloquear a gravação dele. A régua em si é em
   * `lib/leads/padrao-do-campo` — fecha a porta com frase legível e nunca
   * lança — e é lá que a regex inválida vira `padrao_invalido`.
   *
   * `mensagem_padrao` é a frase que o DONO escreveu para quem digitar fora do
   * formato ("Use só números separados por vírgula, ex.: 2,9"). É dado, não
   * interface: aparece como está, em qualquer idioma, porque traduzi-la seria
   * trocar a instrução que o próprio operador deu.
   */
  padrao: z.string().optional(),
  mensagem_padrao: z.string().optional(),
  /**
   * PERMITIR VALOR NOVO (issue #2521) — só faz sentido no `searchable_select`.
   *
   * LIGADO, a pessoa pode cadastrar na ficha um valor que não está na lista e
   * ele é gravado como digitado. DESLIGADO (o padrão, e a chave ausente em toda
   * definição que já existe), a escrita só aceita um valor que case com uma
   * opção (por `value`, `label` ou apelido), gravando o `value` CANÔNICO.
   * Hoje a régua vale na ficha (CustomFieldsEditor); `validarValorPesquisavel`
   * existe pronta para as escritas do servidor, ainda não plugada (#2521).
   */
  allow_new: z.boolean().optional(),
  /**
   * MÚLTIPLA ESCOLHA (issue #3182) — só faz sentido no `searchable_select`.
   *
   * LIGADO, o campo grava uma LISTA de valores canônicos em vez de um só: numa
   * venda "forfait" o mesmo negócio tem vários fornecedores (aéreo pela
   * consolidadora A, hotel pela operadora B), dois hotéis, duas companhias — e
   * com um valor só o relatório "quanto vendemos com cada fornecedor" sai
   * incompleto. A busca com apelidos e a canonicalização continuam as mesmas,
   * por item (`lib/leads/campos-pesquisaveis`).
   *
   * DESLIGADO (o padrão, e a chave ausente em toda definição que já existe), o
   * campo segue de valor único, byte a byte: nada do que está gravado hoje muda
   * de forma. É a chave `multiple: true` do item 1 da issue, escolhida em vez de
   * um tipo novo no enum — o tipo `searchable_select` já é o que a tela, o
   * schema e a API conhecem, e o modo é uma propriedade dele.
   */
  multiple: z.boolean().optional(),
});
export type CustomFieldDef = z.infer<typeof customFieldSchema>;

/**
 * A COTA DE CAMPOS DO NEGÓCIO por funil (issue #3111).
 *
 * O teto de 50 nasceu quando TODO campo do funil era do NEGÓCIO. Desde a #2791
 * os campos do CONTATO também são declarados no funil padrão (`escopo:
 * "contato"`) e passaram a DISPUTAR a mesma cota: a instalação do autor, com 20
 * campos do negócio + 20 do contato, chegava a 40 de 50 e travava antes de
 * cobrir o negócio.
 *
 * A cota continua 50, e passa a valer SÓ para o NEGÓCIO. O campo do contato não
 * aparece no card e o valor dele mora em `contacts.custom_fields`, não em
 * `crm_leads.custom_fields` — não é um campo do funil na conta que importa.
 * Não há cota própria do contato: nada no produto limita quantos campos uma
 * ficha de contato pode declarar.
 *
 * A régua do NEGÓCIO NÃO afrouxou: a ausência de `escopo` lê como `negocio`
 * (mesma leitura de `lib/leads/campos-do-funil.ts`), então toda definição que já
 * existe continua contando e 51 campos do negócio seguem recusados.
 */
export const MAX_CAMPOS_DO_NEGOCIO = 50;

/** A recusa do teto, legível: diz o número e o que não entra na conta. */
export const MENSAGEM_DO_TETO_DE_CAMPOS_DO_NEGOCIO = `O funil aceita no máximo ${MAX_CAMPOS_DO_NEGOCIO} campos do negócio. Os campos do contato não entram nesta conta.`;

/**
 * `fields` do PATCH: a cota conta só os campos do NEGÓCIO.
 *
 * O array segue sendo `customFieldSchema[]` (a forma de cada campo não mudou) —
 * o que mudou é O QUE a cota conta. Quem escreve a mensagem é esta régua, para
 * a tela do funil e a captação dizerem a mesma frase.
 */
export const camposDoFunilPatchSchema = z
  .array(customFieldSchema)
  .superRefine((campos, ctx) => {
    const doNegocio = campos.filter((campo) => campo.escopo !== "contato").length;
    if (doNegocio > MAX_CAMPOS_DO_NEGOCIO) {
      ctx.addIssue({
        code: "custom",
        message: `${MENSAGEM_DO_TETO_DE_CAMPOS_DO_NEGOCIO} Recebidos ${doNegocio}.`,
      });
    }
  });

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
  fields: camposDoFunilPatchSchema.optional(),
  /**
   * Os motivos de perda do funil (issue #1537): texto puro continua valendo —
   * nenhum funil existente precisa migrar dado — e quem quiser agrupar no
   * relatório "Perdas" grava `{ label, categoria }`. O rótulo é o mesmo de
   * antes (mesmo teto de 80 caracteres); a categoria é opcional e cabe em 40.
   *
   * O trigger `fn_validate_lost_reason_required` lê o `label` dos objetos e o
   * texto dos strings — a mesma régua, dois formatos. Gravar só o texto e
   * filtrar depois por prefixo faria o filtro virar busca, que é a alternativa
   * que a issue descarta.
   */
  lost_reasons: z
    .array(
      z.union([
        z.string().min(1).max(80),
        z.object({
          label: z.string().min(1).max(80),
          categoria: z.string().min(1).max(40).optional(),
        }),
      ]),
    )
    .max(50)
    .optional(),
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
   * A comanda do ganho, opt-in por funil (CR do PR #2220, #1477). Ausente ou
   * `false` é DESLIGADO — o padrão que a doutrina de extensões exige ("se
   * nenhuma organização ativar isto, a operação comum continua inteira?"): em
   * loja com checkout, infoproduto ou imobiliária o valor do negócio não é
   * conta a receber. Quem lê é o consumidor de `lead.won`
   * (`lib/financeiro/comanda-do-ganho.handler.ts`), não esta tela.
   */
  comanda_no_ganho: z.boolean().optional(),
  /**
   * O que acontece quando um negócio ENCERRADO volta (issue #1538). Ausente é
   * `mesmo_registro`, o comportamento de antes: reabre o mesmo negócio. Com
   * `novo_negocio`, mover o encerrado para etapa aberta é recusado e a saída é
   * a retomada (`lib/leads/reabertura.ts`).
   */
  reabertura: z.enum(["mesmo_registro", "novo_negocio"]).optional(),
  /** O que a retomada copia da origem; ausente é o piso (`custom_fields` e tags). */
  reabertura_campos: z.array(z.enum(CAMPOS_COPIAVEIS_NA_RETOMADA)).max(8).optional(),
  /**
   * A ENTRADA DO INBOX — em que ETAPA deste funil a conversa nova vira card
   * (issue #3011, fatia 1).
   *
   * Hoje a etapa de entrada não é escolhida por ninguém: é a de menor
   * `position` entre as não-arquivadas (`lib/leads/nascimento-do-lead.ts`). Quem
   * opera com uma etapa "Conversas iniciadas" não tinha como dizer isso ao
   * produto — a conversa nascia na primeira etapa que já existia, e a separação
   * entre "chegou" e "está sendo atendido" ficava por conta de arrasto manual.
   *
   * ⚠️ O QUE ESTE BLOCO **NÃO** ESCOLHE: o FUNIL. O card continua nascendo no
   * funil de entrada (`crm_pipelines.is_default`), e só a ETAPA é declarada
   * aqui. Escolher o funil dentro do `settings` de um funil seria a roda
   * quadrada — o valor apontaria para outra linha da mesma tabela e nenhum
   * CHECK poderia cobrar que ela exista, seja do mesmo tenant ou não.
   *
   * ⚠️ A CHAVE É `ativa`. Como em `settings.crm.cliente_pela_agenda`, só o
   * `true` EXPLÍCITO liga; ausente, `false` ou qualquer outro valor é o
   * comportamento de sempre (a primeira etapa). Quem lê confere o `stage_id`
   * de novo contra o banco — `z.uuid()` aqui diz que o valor tem forma de
   * identificador, não que a etapa exista, esteja neste funil ou esteja aberta:
   * a régua final é a consulta, e é ela que impede um card nascer em etapa de
   * outro tenant ou em "Perdido".
   *
   * `stage_id` é opcional para a tela poder DESLIGAR sem perder a etapa
   * escolhida — religar não deve obrigar a escolher de novo.
   */
  entrada_do_inbox: z
    .object({
      ativa: z.boolean(),
      stage_id: z.uuid().nullable().optional(),
    })
    .optional(),
  /**
   * O RECORTE DE ENCERRADOS ANTIGOS do quadro (#2995) — a opção POR FUNIL que
   * deixa fora da tela os negócios encerrados há mais de N dias. Ausente ou `0`
   * é DESLIGADO: o quadro continua trazendo tudo, como sempre trouxe.
   *
   * `0` E NÃO `null` PARA O "DESLIGUEI", e essa é a parte que importa: a action
   * faz merge com o settings que está no banco gravando só as chaves que vêm no
   * patch, então um `undefined` deixaria o valor antigo na linha — a pessoa
   * desligaria a opção, salvaria, e os cards continuariam sumindo. O teto
   * (`DIAS_MAXIMO_DO_RECORTE`, dez anos) vem do domínio
   * (`lib/kanban/recorte-de-encerrados`), que é quem decide o que é um recorte
   * válido: um número escrito aqui e outro lá divergiriam no primeiro ajuste.
   */
  ocultar_encerrados_dias: z.number().int().min(0).max(DIAS_MAXIMO_DO_RECORTE).optional(),
  /**
   * OS ATALHOS DO CARD (issue #3487) — os botões que abrem outro sistema com o
   * dado do cliente: `tel:` para o softphone do PABX, `https://…?cliente={{erp_id}}`
   * para o app de pedidos.
   *
   * ─── A régua do ESQUEMA, e por que ela está aqui ──────────────────────────
   *
   * O `url` é digitado por uma pessoa e renderizado para outras: o valor vira
   * `<a href>`, e `javascript:`/`data:` num href é execução de código a um
   * clique. A allowlist (`tel:`, `http:`, `https:`) RECUSA NA GRAVAÇÃO, e a
   * renderização revalida o que veio do banco (`lib/leads/atalhos-do-card.ts`,
   * `atalhosParaExibir`) — o `settings` é jsonb, escrito também por script, seed
   * e restauração de backup, e um valor posto por fora passaria por esta porta
   * sem tocá-la.
   *
   * ⚠️ `refine` e não `z.enum`: a mensagem de erro precisa dizer QUAL regra
   * caiu, e o formulário lê o `details` para marcar a linha errada.
   *
   * `atalhos` AUSENTE é o estado de todo funil instalado: nenhum botão, e o card
   * continua idêntico ao de antes desta entrega.
   */
  atalhos: z
    .array(
      z.object({
        rotulo: z.string().trim().min(1).max(TAMANHO_MAXIMO_DO_ROTULO),
        icone: z.enum(ICONES_DE_ATALHO),
        url: z
          .string()
          .trim()
          .min(1)
          .max(TAMANHO_MAXIMO_DO_MODELO)
          .refine(modeloAceito, { message: "esquema_nao_permitido" }),
      }),
    )
    .max(MAX_ATALHOS)
    .optional(),
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
  /**
   * A cor da marca NO TEMA ESCURO (#2482) — o par de `accent_hex`, do mesmo
   * jeito que a tela já tem o par de logo.
   *
   * `.nullable()` como os irmãos: `null` é "apague", e os dois temas voltam a
   * derivar da cor principal. A retrocompatibilidade que a issue pede não mora
   * aqui — ela mora no BANCO (`accent_dark_hex` pode ser `null` em toda linha
   * gravada antes da coluna) e no envelope (`corEscura` some do objeto
   * resolvido), que são os dois lados que código antigo lê.
   */
  accent_dark_hex: z
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
  /** A cor do TEMA ESCURO (#2482) — o par de `accent_hex`, mesma validação. */
  accent_dark_hex: z
    .string()
    .trim()
    .refine(ehHexValido, { message: "Use uma cor no formato #rrggbb" })
    .nullable(),
  /**
   * O remetente do e-mail de AUTOMAÇÃO da organização (#3287, fatia 1) — o nome
   * de exibição e o "responder para".
   *
   * `email_from_name` é texto livre (limite de 120, o mesmo do nome da empresa:
   * cabeçalho `From:` longo é o que os clientes de e-mail cortam). Vazio vira
   * `null` na tela, e `null` é "use o da plataforma".
   */
  email_from_name: z.string().trim().max(120).nullable(),
  /**
   * `email_reply_to` valida com o MESMO piso de "cara de endereço" do disparo
   * (`lib/email/remetente-da-organizacao.ts`): recusar aqui é o conserto que a
   * pessoa vê na tela, em vez de um `Reply-To:` torto que o provedor devolveria
   * como erro opaco no meio de um envio real.
   */
  email_reply_to: z
    .string()
    .trim()
    .max(254)
    .refine((valor) => valor === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor), {
      message: "Use um endereço de e-mail como contato@suaempresa.com",
    })
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
 *
 * `cliente_pela_venda` e `pos_venda_dias` (#3644): quem já COMPROU volta pelo
 * funil de clientes, e não pelo de captação — e, dentro da janela de pós-venda,
 * a conversa não vira card nenhum. As duas nascem desligadas; a régua de leitura
 * é a mesma da chave acima.
 *
 * `internal_contact_tags` (#2353): a lista de etiquetas que marcam um contato
 * INTERNO (equipe, sócio, família, fornecedor). Contato com uma delas não vira
 * card e não recebe atendimento da IA — ver `lib/contacts/tags-internas.ts`.
 * Mora no MESMO bolso jsonb porque já existia para a chave acima: nenhuma
 * coluna nem tabela nova, e o par (liga/desliga + lista) fica no lugar em que a
 * organização já procura as regras de CRM. Ausente/lixo → lista vazia (nenhum
 * contato é interno), que é o comportamento de antes desta chave existir.
 */
export const internalContactTagsSchema = z.array(z.string()).catch([]);

export const crmSettingsSchema = z
  .object({
    cliente_pela_agenda: z.boolean().catch(false),
    internal_contact_tags: internalContactTagsSchema,
    /**
     * `telefone_de_ficha_vazia` (issue #2593): o telefone que o cliente diz
     * numa conversa entra SOZINHO na ficha SEM número — sem passar pela fila de
     * proposta que a spec 17 §4b exige para o resto do dado ouvido.
     *
     * ⚠️ NASCE DESLIGADA em toda organização, e é o oposto do `cliente_pela_agenda`
     * só na régua de leitura: lá "ausente = desligado", aqui TAMBÉM (só o booleano
     * `true` liga). Não é assimetria acidental — a spec 17 §4b diz que o dado
     * ouvido é PROPOSTO, não gravado, e a exceção só existe onde quem instala
     * decide abrir mão dessa garantia. Um jsonb ausente tem de continuar sendo o
     * comportamento de sempre.
     *
     * Não mora no `settings.agenda` porque aquele objeto é SUBSTITUÍDO inteiro
     * pelo `fn_agenda_settings` (ver `colegasPodemMexerNaAgendaLigado`); `crm` é
     * o bloco que as regras de contato já usam.
     */
    telefone_de_ficha_vazia: z.boolean().catch(false),
    /**
     * `cliente_pela_venda` (#3644): quem JÁ COMPROU (tem negócio `won` e nenhum
     * aberto) volta pelo funil de clientes, e não pelo de captação.
     *
     * ⚠️ NASCE DESLIGADA em toda organização, e a régua é a mesma das outras
     * duas chaves: só o booleano `true` liga. Desligada, o roteamento é
     * exatamente o de antes desta chave existir (`first_service_at` com a regra
     * da agenda ligada) — é o que permite entregar a regra sem tocar em quem não
     * a pediu.
     *
     * Mora no `crm` porque é uma regra de CONTATO, como as vizinhas — nenhuma
     * coluna nem tabela nova, como o mantenedor decidiu no #2593.
     */
    cliente_pela_venda: z.boolean().catch(false),
    /**
     * `pos_venda_dias` (#3644): a janela em que a conversa de quem acabou de
     * comprar NÃO abre negócio nenhum. `0` (o padrão) desliga a janela: o card
     * nasce sempre, como hoje.
     *
     * Teto de 365 porque o que isto cobre é pós-venda imediato ("chegou
     * certinho?"), não o relacionamento inteiro com o cliente — e um número
     * fora da faixa é configuração torta, não intenção: cai em `0` (o
     * comportamento de sempre) em vez de segurar conversa por um ano por causa
     * de um dígito a mais.
     */
    pos_venda_dias: z.number().int().min(0).max(365).catch(0),
  })
  .catch({
    cliente_pela_agenda: false,
    internal_contact_tags: [],
    telefone_de_ficha_vazia: false,
    cliente_pela_venda: false,
    pos_venda_dias: 0,
  });

/**
 * `organizations.settings.notificacoes.conteudo_na_tela_bloqueada` — o que o
 * aviso do celular mostra com a tela bloqueada: nada além de "chegou algo"
 * (`oculto`), quem mandou sem a mensagem (`nome`), ou quem mandou e o começo
 * da mensagem (`nome_e_previa`). O padrão `nome` é decisão do dono do produto.
 *
 * Lido pelo funil do push (`lib/notifications/web_push.ts`) e pela rota
 * `conversations/[id]/aviso-de-mensagem`; gravado só por
 * `definirConteudoNaTelaBloqueada`.
 */
export const CONTEUDOS_NA_TELA_BLOQUEADA = ["oculto", "nome", "nome_e_previa"] as const;
export type ConteudoNaTelaBloqueada = (typeof CONTEUDOS_NA_TELA_BLOQUEADA)[number];
export const CONTEUDO_NA_TELA_BLOQUEADA_PADRAO: ConteudoNaTelaBloqueada = "nome";

export const conteudoNaTelaBloqueadaWriteSchema = z.enum(CONTEUDOS_NA_TELA_BLOQUEADA);

export const notificacoesSettingsSchema = z
  .object({
    conteudo_na_tela_bloqueada: conteudoNaTelaBloqueadaWriteSchema.catch(CONTEUDO_NA_TELA_BLOQUEADA_PADRAO),
  })
  .catch({ conteudo_na_tela_bloqueada: CONTEUDO_NA_TELA_BLOQUEADA_PADRAO });

/** O que aparece com a tela bloqueada nesta organização. Nunca lança. */
export function conteudoNaTelaBloqueada(settings: unknown): ConteudoNaTelaBloqueada {
  const notificacoes =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).notificacoes
      : undefined;
  return notificacoesSettingsSchema.parse(notificacoes ?? {}).conteudo_na_tela_bloqueada;
}

/** A regra "cliente pela agenda" está ligada nesta organização? Nunca lança. */
export function clientePelaAgendaLigado(settings: unknown): boolean {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  return crmSettingsSchema.parse(crm ?? {}).cliente_pela_agenda === true;
}

/**
 * As etiquetas de contato INTERNO desta organização, na forma em que o banco as
 * guarda (`normalizarTag`: minúscula, aparada, sem repetição). Nunca lança — um
 * jsonb torto devolve lista vazia, que é "nenhum contato é interno", o mesmo
 * estado de toda organização que nunca configurou a lista.
 */
export function tagsInternasDaOrg(settings: unknown): string[] {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  return normalizarTags(crmSettingsSchema.parse(crm ?? {}).internal_contact_tags);
}

/**
 * O interruptor de #2593 está ligado nesta organização? **Desligado por
 * padrão**, e nunca lança.
 *
 * A régua é "SÓ O BOOLEANO `true` LIGA": ausente, `false`, a string `"true"`,
 * `1`, array ou qualquer lixo é DESLIGADO. É deliberadamente o mais
 * conservador dos dois lados — quem atualizar o produto sem abrir a tela
 * continua com a regra da spec 17 §4b intacta (o dado ouvido é proposto, não
 * gravado), e um `settings` torto nunca liga uma escrita automática por
 * acidente.
 */
export function telefoneDeFichaVaziaLigado(settings: unknown): boolean {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  return crmSettingsSchema.parse(crm ?? {}).telefone_de_ficha_vazia === true;
}

/**
 * As regras de CONTATO do bloco `settings.crm`, lidas de UMA vez (#3644).
 *
 * ⚠️ EXISTE PORQUE AGORA SÃO TRÊS CHAVES NO MESMO OBJETO. O nascimento do lead
 * decide o funil por duas delas (`cliente_pela_agenda` e `cliente_pela_venda`)
 * e a janela de pós-venda pela terceira: lendo chave por chave, seriam três
 * `select settings` na MESMA linha de `organizations` — no caminho quente da
 * ingestão, por mensagem recebida. Uma leitura só, três respostas.
 *
 * A régua é a das vizinhas: só o booleano `true` liga, `pos_venda_dias` fora de
 * 0–365 (ou torto) cai em `0`. Nunca lança.
 */
export interface RegrasDeCliente {
  /** `first_service_at` preenchido passa a contar como cliente (migration 0262). */
  pelaAgenda: boolean;
  /** Negócio ganho sem nada aberto conta como cliente (#3644). */
  pelaVenda: boolean;
  /** Janela, em dias, em que a conversa de quem acabou de comprar não abre card. */
  posVendaDias: number;
}

export function regrasDeCliente(settings: unknown): RegrasDeCliente {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  const lido = crmSettingsSchema.parse(crm ?? {});
  return {
    pelaAgenda: lido.cliente_pela_agenda === true,
    pelaVenda: lido.cliente_pela_venda === true,
    posVendaDias: lido.pos_venda_dias,
  };
}

/** A regra "cliente pela venda" está ligada nesta organização? Nunca lança. */
export function clientePelaVendaLigado(settings: unknown): boolean {
  return regrasDeCliente(settings).pelaVenda;
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

/**
 * A opção "MEET ABERTO" (#2063) — reunião criada pelo CRM com o link que
 * qualquer um com o link entra, sem "pedir para participar".
 *
 * RÉGUA "SÓ O `true` EXPLÍCITO LIGA", como `settings.crm.cliente_pela_agenda`:
 * a opção NASCE DESLIGADA em toda organização que já instalou, e o risco é
 * parte do desenho — quem tiver o link entra sem pedir. Ausente, `false`, a
 * string `"true"` ou qualquer lixo é desligado.
 *
 * Mora em chave PRÓPRIA de topo (`settings.google_meet_acesso_aberto`), no
 * mesmo espírito de `colegas_podem_mexer_na_agenda`: NÃO fica em
 * `settings.agenda`, porque `fn_agenda_settings` SUBSTITUI o objeto `agenda`
 * inteiro e recusa chave que não as duas que conhece — a chave seria apagada na
 * primeira vez que um Gerente salvasse os prazos.
 *
 * Nunca lança: um jsonb torto não pode derrubar Configurações.
 */
/** O AVISO DE RISCO da opção — a frase que a tela mostra ao lado do interruptor. */
export const AVISO_MEET_ABERTO =
  "⚠ Com o Meet aberto, quem tiver o link da reunião entra sozinho, sem que ninguém o admita. O link é a porta: não o publique onde circula livremente.";

export function meetAbertoLigado(settings: unknown): boolean {
  const raiz =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : undefined;
  return raiz?.google_meet_acesso_aberto === true;
}
