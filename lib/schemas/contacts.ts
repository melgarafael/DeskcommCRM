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
import { isValidCpf, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";

const PHONE_REGEX = /^\+\d{8,15}$/;

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
 * O E.164 é universal; o EXEMPLO não. A mensagem de erro cravava
 * `+5511999998888`, então a tela mostrava o exemplo do país no campo e ensinava
 * o DDI brasileiro assim que a pessoa errava — dentro do mesmo formulário.
 */
function telefoneDoPais(perfil: PerfilDoPais) {
  return z
    .string()
    .regex(PHONE_REGEX, `Telefone deve estar em formato E.164 (${perfil.telefoneExemplo})`)
    .optional();
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
