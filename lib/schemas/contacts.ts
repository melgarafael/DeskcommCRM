/**
 * Zod schemas for `/api/v1/contacts/*` endpoints (EPIC-05 waves 1, 2, 8).
 *
 * Contracts:
 *  - contactCreateSchema    → POST /api/v1/contacts
 *  - contactPatchSchema     → PATCH /api/v1/contacts/[id]
 *  - contactListQuerySchema → GET /api/v1/contacts (search/tag/source/cursor)
 *  - lgpdAnonymizeSchema    → POST /api/v1/lgpd/anonymize (irreversible)
 */
import { z } from "zod";

import { normalizarTag, normalizarTags } from "@/lib/contacts/tag-normalizada";
import {
  MAXIMO_DE_ETIQUETAS_NO_FILTRO,
  MODOS_DE_ETIQUETA,
} from "@/lib/inbox/marcador-da-conversa";
import { isValidCpf, PAIS_PADRAO, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";

export const PHONE_REGEX = /^\+\d{8,15}$/;

/**
 * O TIPO DO CONTATO (issue 3005, fatia 1): cliente (padrão) ou fornecedor.
 *
 * As DUAS palavras do produto moram numa constante porque a tela, o schema e a
 * migration precisam da MESMA lista: o CHECK `contacts_contact_type_check`
 * guarda estes dois valores, e uma terceira palavra no schema que o banco não
 * conhece seria `23514` no caminho de gravação.
 *
 * O default é do BANCO (`'cliente'`, migration 0763), não do Zod: um PATCH que
 * não fala de tipo não pode materializar `contact_type` no payload e reescrever
 * a coluna de quem já é fornecedor — mesma régua do `source` no PATCH, que
 * ficou sem default exatamente por isso (`contactPatchSchema`, mais abaixo).
 */
export const CONTACT_TIPOS = ["cliente", "fornecedor"] as const;
export const contactTypeSchema = z.enum(CONTACT_TIPOS);
export type ContactType = z.infer<typeof contactTypeSchema>;

/**
 * Teto de 32 KB no jsonb inteiro. O CHECK do banco só garante que é OBJETO —
 * sem limite de tamanho, um cliente da API escreveria megabytes numa coluna que
 * a listagem de contatos traz inteira, e o custo apareceria como "a tela de
 * contatos ficou lenta", longe da causa.
 */
const CUSTOM_FIELDS_MAX_BYTES = 32_768;

const customFieldsSchema = z
  .record(z.string().min(1).max(80), z.unknown())
  .refine((value) => JSON.stringify(value).length <= CUSTOM_FIELDS_MAX_BYTES, {
    message: "Campos personalizados excedem o limite de 32 KB",
  });

/**
 * O mod-11 da Receita Federal mora no PERFIL do país
 * (`lib/legal/perfil-do-pais.ts`), porque é ele quem responde pelo documento do
 * titular — aqui fica só o re-export, para não existirem duas implementações da
 * mesma regra. Quem importava deste módulo (rota de importação, testes,
 * `lib/schemas/index.ts`) continua importando.
 */
export { isValidCpf };

export const contactCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  display_name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  phone_number: z
    .string()
    .regex(PHONE_REGEX, "Telefone deve estar em formato E.164 (+5511999998888)")
    .optional(),
  cpf: z.string().refine(isValidCpf, "CPF inválido").optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // Endereço da pessoa física (issue 3494): os mesmos campos que entrega e
  // cobrança precisam, espelhando `companies`.
  zip_code: z.string().max(16).optional().nullable(),
  street: z.string().max(300).optional().nullable(),
  number: z.string().max(40).optional().nullable(),
  complement: z.string().max(120).optional().nullable(),
  district: z.string().max(120).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  state: z.string().max(2, "UF com 2 letras (ex.: SP)").optional().nullable(),
  // O papel do contato (issue 3005): ausente = o default do BANCO ('cliente'),
  // e por isso `contactPatchSchema` também o deixa opcional — um PATCH que só
  // troca o nome não reescreve o tipo de um fornecedor.
  contact_type: contactTypeSchema.optional(),
  // O marcador nasce em caixa baixa, pela MESMA regra da tag de conversa: o
  // "VIP" gravado verbatim não casava com o filtro `?tag=vip` (issue #1224).
  tags: z.array(z.string()).transform(normalizarTags).optional(),
  source: z.string().min(1).default("manual"),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
  consent: z.record(z.string(), z.unknown()).optional(),
  custom_fields: customFieldsSchema.optional(),
});
export type ContactCreate = z.infer<typeof contactCreateSchema>;

export const contactPatchSchema = contactCreateSchema.partial().extend({
  source: z.string().min(1).optional(),
});
export type ContactPatch = z.infer<typeof contactPatchSchema>;

/**
 * O documento do titular vem do PERFIL DO PAÍS da organização (issue #1033).
 *
 * `contactCreateSchema` continua sendo a régua brasileira, para quem não tem um
 * perfil em mãos. Estas fábricas trocam o campo do documento e a MENSAGEM do
 * telefone (o E.164 é universal; o exemplo não era): tudo o mais é o MESMO
 * schema, estendido, e não uma segunda cópia — duas listas de campos divergem
 * no dia em que uma ganhar um campo novo.
 *
 * Por que fábrica e não ler o país aqui dentro: o schema é síncrono e puro, e a
 * resposta certa vem do banco (`perfilDaOrganizacao`), resolvida uma vez por
 * requisição na borda. O que NÃO se faz é deixar o corpo da requisição escolher
 * o país — quem decide é a organização, pela coluna dela (mesma doutrina da
 * moeda em `lib/catalogo/moeda-da-org.ts`).
 */
export function contactCreateSchemaDoPais(perfil: PerfilDoPais) {
  return contactCreateSchema.extend({
    cpf: z
      .string()
      .refine(perfil.documento.valida, perfil.documento.mensagemInvalido)
      .optional(),
    phone_number: telefoneDoPais(perfil),
  });
}

/**
 * O TELEFONE NACIONAL DA ORGANIZAÇÃO BRASILEIRA (#3301).
 *
 * O E.164 é universal, mas obrigar quem está no Brasil a digitar o `+55` do
 * próprio país é pedir o código de um lugar onde a pessoa já está. A
 * organização brasileira passa a aceitar o que o brasileiro digita —
 * `(11) 99999-8888`, `11 99999-8888`, `11 3322-4455`, `11999998888` — e a API
 * grava a forma canônica (`+5511999998888`), que é a que o resto do produto
 * espera (`lib/channels/phone-variants.ts`).
 *
 * ─── Por que a régua do DDD é a do produto, e não uma nova ────────────────
 *
 * Dois dígitos, o primeiro de 1 a 9: EXATAMENTE a régua de
 * `phoneLookupVariants`. Duas réguas de DDD divergiriam no dia em que uma
 * delas aprendesse um caso novo, e a divergência apareceria longe da causa —
 * um número que o cadastro aceita e a busca por duplicados não casa.
 *
 * ─── O que estas duas funções NÃO fazem ──────────────────────────────────
 *
 * Não inventam o nono dígito do celular: local de 8 dígitos é fixo, e quem
 * completa o nono é `canonicalPhoneBR`, no caminho do canal. Inventá-lo aqui
 * fundiria o fixo de uma pessoa com o celular de outra.
 */
const DDD_BR = /^[1-9][0-9]$/;

/** DDD + número (8 ou 9 dígitos, com ou sem máscara) → E.164 com `+55`; `null` fora disso. */
function telefoneNacionalE164(valor: string): string | null {
  const digitos = valor.replace(/\D/g, "");
  // 12 ou 13 dígitos COM o DDI na frente é o caso de quem colou o número
  // completo e esqueceu o `+` (a issue #3301 pede os dois formatos). O DDI sai,
  // e o resto é julgado pela régua nacional — o `55` colado não dispensa a
  // conferência do DDD.
  const nacional =
    (digitos.length === 12 || digitos.length === 13) && digitos.startsWith("55")
      ? digitos.slice(2)
      : digitos;
  if (nacional.length !== 10 && nacional.length !== 11) return null;
  if (!DDD_BR.test(nacional.slice(0, 2))) return null;
  return `+55${nacional}`;
}

/**
 * A régua do telefone DA ORGANIZAÇÃO.
 *
 * O E.164 é universal; o EXEMPLO não. A mensagem de erro cravava
 * `+5511999998888`, então a tela mostrava o exemplo do país no campo e ensinava
 * o DDI brasileiro assim que a pessoa errava — dentro do mesmo formulário.
 *
 * No Brasil entra também o formato nacional, e a NORMALIZAÇÃO mora no schema,
 * e não na tela, porque a tela não é a única porta: a API v1 de contatos
 * (POST e PATCH /api/v1/contacts) e a importação por planilha chamam esta
 * mesma fábrica. Os demais países seguem como estavam —
 * o formato internacional completo é o único aceito.
 *
 * `.transform()` ANTES do `.refine()`: o `refine` julga o valor já
 * normalizado, então `(11) 99999-8888` e `+5511999998888` passam pela mesma
 * régua E.164, e o que ele recusa é o valor que, depois de normalizado,
 * continua não sendo E.164.
 */
function telefoneDoPais(perfil: PerfilDoPais) {
  const brasileiro = perfil.codigo === PAIS_PADRAO;
  return z
    .string()
    .transform((valor) => (brasileiro ? normalizarTelefoneBR(valor) : valor))
    .refine((valor) => PHONE_REGEX.test(valor), { message: mensagemDoTelefone(perfil) })
    .optional();
}

/** O que já é E.164 passa intacto; o nacional brasileiro ganha o `+55`. O resto segue para o `refine` recusar. */
function normalizarTelefoneBR(valor: string): string {
  if (PHONE_REGEX.test(valor)) return valor;
  // Quem escreveu o `+` declarou o DDI: `+1 (415) 555-1234` é os Estados
  // Unidos, e a régua nacional o leria como DDD 14 + celular — `+5514155551234`,
  // o número de outra pessoa. É a mesma leitura de `normalizePhoneBR`
  // (lib/channels/phone-variants.ts): quem vem com `+` é respeitado. Só a
  // máscara (espaço, parêntese, ponto, traço) sai; letra e ramal ficam, e o
  // `refine` os recusa.
  if (valor.trim().startsWith("+")) return `+${valor.trim().slice(1).replace(/[\s().-]/g, "")}`;
  return telefoneNacionalE164(valor) ?? valor;
}

/**
 * A frase que ensina o formato, por país.
 *
 * O exemplo vem do PERFIL — é o `placeholder` do formulário, e a frase abaixo
 * do campo não pode discordar dele. No Brasil o exemplo nacional é DERIVADO
 * do E.164 do perfil (sem o `+55`), em vez de escrito à mão: um exemplo
 * cravado envelhece calado no dia em que o perfil mudar.
 */
function mensagemDoTelefone(perfil: PerfilDoPais): string {
  if (perfil.codigo !== PAIS_PADRAO) {
    return `Telefone deve estar em formato E.164 (${perfil.telefoneExemplo})`;
  }
  const exemploNacional = perfil.telefoneExemplo.replace(/^\+55/, "");
  return `Telefone deve ter DDD + número (ex.: ${exemploNacional}) ou o formato E.164 (${perfil.telefoneExemplo})`;
}

/** O mesmo, para o PATCH (`app/api/v1/contacts/[id]/route.ts`). */
export function contactPatchSchemaDoPais(perfil: PerfilDoPais) {
  return contactPatchSchema.extend({
    cpf: z
      .string()
      .refine(perfil.documento.valida, perfil.documento.mensagemInvalido)
      .optional(),
    phone_number: telefoneDoPais(perfil),
  });
}

export const CONTACT_ORDER_BY = [
  "last_activity_at",
  "created_at",
  "display_name",
  "email",
  "phone_number",
] as const;

export const contactListQuerySchema = z.object({
  search: z.string().optional(),
  // O filtro normaliza pelo MESMO caminho da escrita: `?tag=VIP` acha o que a
  // ficha gravou como "vip" (issue #1224).
  //
  // ⚠️ E agora VÁRIAS etiquetas (#1274). Aceita `string` OU `string[]`, e a
  // repetição na URL (`?tag=vip&tag=orçamento`) é lida por `getAll`. Aceitar as
  // DUAS formas é o que mantém o `?tag=vip` singular funcionando: `get` devolve
  // string e `getAll` devolve array de um, e os dois precisam passar pelo MESMO
  // schema — se este só aceitasse array, toda chamada antiga quebraria com 422.
  tag: z
    .union([
      z.string().transform(normalizarTag),
      z.array(z.string().transform(normalizarTag)).max(MAXIMO_DE_ETIQUETAS_NO_FILTRO),
    ])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const lista = Array.isArray(v) ? v : [v];
      // Lista VAZIA vira `undefined`, e não `[]` — mesma razão do schema do
      // Inbox: `getAll` devolve `[]` sem o parâmetro, e `[]` num `cs` é um filtro
      // que não casa nada, com o filtro desligado.
      return lista.length > 0 ? lista : undefined;
    }),
  /**
   * E ou OU entre as etiquetas escolhidas (#1274). `e` é o padrão — e é o que
   * uma etiqueta só já significava, logo o parâmetro só importa havendo duas.
   *
   * `z.enum` recusa o valor fora dos dois, e a recusa vira 422: `?modo=xou` é
   * quase sempre alguém copiando o nome do parâmetro errado, e a resposta
   * ensina o integrador a corrigir. Na TELA quem lê é `modoDeEtiqueta`, que cai
   * no `e` — uma tela não pode quebrar por um parâmetro inventado.
   */
  modo: z.enum(MODOS_DE_ETIQUETA).optional(),
  source: z.string().optional(),
  /**
   * Só pessoais / esconder pessoais (spec 21, etapa 13).
   *
   * `"true"`/`"false"` como TEXTO — vem de `searchParams`, que só conhece
   * texto — e não `z.coerce.boolean()`, que transformaria `"false"` em `true`
   * (o mesmo aviso de `is_group` em `lib/schemas/messaging.ts`). Aceita
   * boolean de verdade porque o MCP chama este schema direto, sem URL no
   * meio. Ausente = excluir pessoais: o padrão da lista e do MCP search.
   */
  pessoais: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
  /**
   * A LISTA DE QUEM PEDIU PARA NÃO SER INCOMODADO.
   *
   * Sem isto o bloqueio existia só como etiqueta na linha: para saber quem
   * pediu era preciso percorrer a lista inteira a olho. Responde só pelo
   * opt-out do titular: a lista de exclusão de campanha e os anonimizados
   * são outras perguntas, fora deste filtro. Ausente = todos (o padrão de
   * sempre); `z.enum` recusa o valor inventado com 422, como o `modo`.
   */
  blocked: z.enum(["yes", "no"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  order_by: z.enum(CONTACT_ORDER_BY).default("last_activity_at"),
  order_dir: z.enum(["asc", "desc"]).default("desc"),
});
export type ContactListQuery = z.output<typeof contactListQuerySchema>;
export type ContactListQueryParams = z.input<typeof contactListQuerySchema>;
export type ContactOrderBy = (typeof CONTACT_ORDER_BY)[number];

export const lgpdAnonymizeSchema = z.object({
  contact_id: z.string().uuid(),
  justification: z.string().min(10).max(1000),
});
export type LgpdAnonymizeInput = z.infer<typeof lgpdAnonymizeSchema>;

/**
 * Juntar contatos duplicados.
 *
 * O principal fica FORA do array de secundários e o `refine` é o que garante
 * isso na borda — `fn_mesclar_contatos` recusa o mesmo caso com `22023`, mas um
 * 422 com a lista de campos é o que a tela consegue mostrar. As duas guardas
 * existem porque a rota não é a única porta: a RPC é alcançável por
 * `authenticated` (é assim que a RLS a autoriza), e ela precisa se defender só.
 *
 * O teto de 20 secundários por chamada não é arbitrário: a fusão trava as
 * linhas (`for update`) e reponta toda FK que aponta para elas: um lote grande
 * segura escrita de contato para a organização inteira enquanto roda.
 */
export const contactsMergeSchema = z
  .object({
    primary_contact_id: z.string().uuid(),
    secondary_contact_ids: z.array(z.string().uuid()).min(1).max(20),
  })
  .refine((v) => !v.secondary_contact_ids.includes(v.primary_contact_id), {
    message: "O contato principal não pode estar entre os que serão absorvidos.",
    path: ["secondary_contact_ids"],
  })
  .refine((v) => new Set(v.secondary_contact_ids).size === v.secondary_contact_ids.length, {
    message: "Contato repetido na seleção.",
    path: ["secondary_contact_ids"],
  });
export type ContactsMergeInput = z.infer<typeof contactsMergeSchema>;

/**
 * POST /api/v1/contacts/duplicates/dismiss — "Não são a mesma empresa" (Spec 31, PR A).
 *
 * Exatamente DOIS ids, distintos. A organização não vem daqui: a rota a lê da sessão,
 * e este schema não tem campo para ela (um `organization_id` no corpo é descartado).
 * Comparar sem caixa: UUID é o mesmo id com maiúsculas ou minúsculas.
 */
export const contactsDismissDuplicateSchema = z
  .object({
    contact_ids: z.array(z.string().uuid()).length(2),
  })
  .refine((v) => v.contact_ids[0]?.toLowerCase() !== v.contact_ids[1]?.toLowerCase(), {
    message: "Os dois contatos precisam ser diferentes.",
    path: ["contact_ids"],
  });
export type ContactsDismissDuplicateInput = z.infer<typeof contactsDismissDuplicateSchema>;

/**
 * POST /api/v1/contacts/bulk — as ações em lote da tela de Contatos (#2484, fatia F3).
 *
 * Só as três ações que têm caminho por CONTATO único, e nenhuma outra: a rota
 * de lote encaminha cada id à rota individual, então entrar aqui é ter porta
 * individual. `tag` e `custom-field` passam pelo MESMO PATCH da ficha
 * (`/contacts/[id]`), `carteira` pela única porta que grava
 * `contacts.carteira_user_id` (`/contacts/[id]/carteira`). "Mover card de
 * etapa" e "marcar sempre humano" ficaram FORA por medição: a primeira é
 * endereçada por NEGÓCIO (`/leads/[id]/move`), não por contato, e a segunda só
 * é gravada pelo motor de atendimento — não existe porta individual.
 *
 * A organização NUNCA vem do corpo: cada subchamada lê a da SESSÃO, e este
 * schema não tem campo para ela. O teto de ids é política da ROTA
 * (`TETO_DO_LOTE`), não do schema — quem estoura recebe 422 `bulk_too_large`
 * com o número na mensagem, e não um `validation_error` genérico.
 */
export const bulkContactActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("tag"),
    ids: z.array(z.string().uuid()).min(1),
    op: z.enum(["add", "remove"]),
    // Normalizada no MESMO caminho da escrita (`normalizarTags`), e o PATCH
    // re-normaliza: gravar "VIP" aqui e o filtro procurar "vip" é o defeito da
    // issue #1224, que já está consertado do outro lado.
    tag: z.string().trim().min(1).max(40),
  }),
  z.object({
    action: z.literal("carteira"),
    ids: z.array(z.string().uuid()).min(1),
    /** `null` tira o cliente da carteira — mesmo contrato da rota individual. */
    dono_user_id: z.string().uuid().nullable(),
    origem: z.enum(["manual", "importacao", "atribuicao_automatica"]).optional(),
  }),
  z.object({
    action: z.literal("custom-field"),
    ids: z.array(z.string().uuid()).min(1),
    chave: z.string().trim().min(1).max(80),
    /** `null` apaga a chave; os demais campos do contato permanecem (MERGE). */
    valor: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  }),
]);

export type BulkContactActionInput = z.infer<typeof bulkContactActionSchema>;
