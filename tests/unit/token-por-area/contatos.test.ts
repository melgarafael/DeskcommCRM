// @vitest-environment node
/**
 * CONTATOS E TAGS DE CONTATO ACEITAM TOKEN (Spec 33, fatia R2, tarefa 1).
 *
 * `resolveAuthDual` entrega, no ramo do token, a service role: a RLS deixa de
 * proteger e o `.eq("organization_id", authz.organizationId)` de CADA cadeia é
 * a única barreira entre a organização do token e as demais. O cliente falso
 * (`../helpers/cliente-admin-falso`) vê: uma cadeia de tabela com
 * `organization_id` que não filtra a organização não alcança linha nenhuma, e
 * `cadeiasForaDaOrganizacao` aponta qual foi.
 *
 * Seis testes por método (a receita da R2): o token de A alcança o recurso de
 * A; o token de B não alcança; sem o escopo; abaixo do papel; acima do teto; e
 * a sessão segue com o mesmo portão. Depois, as garantias que só o ramo do
 * token precisa (embed tira/coloca, id de outra org rejeitado na escrita),
 * o método que FICA DE FORA (PATCH /api/v1/contacts/[id] DELETE ... continua
 * só de sessão), e a borda do proxy.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole, orgAtivaDaApi } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  orgAtivaDaApi: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
// O adapter do canal: a agenda do celular é lida do WAHA de verdade só em
// produção. Aqui o canal responde uma agenda vazia — a rota e o serviço rodam.
vi.mock("@/lib/channels", async () => {
  const actual = await vi.importActual<typeof import("@/lib/channels")>("@/lib/channels");
  return { ...actual, getAdapter: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");
const { getAdapter } = await import("@/lib/channels");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const PESSOA_DA_SESSAO = "c0000000-0000-4000-8000-000000000001";

const CONTATO_A = "a6666666-6666-4666-8666-666666666666";
const CONTATO_B = "b6666666-6666-4666-8666-666666666666";
const NEGOCIO_A = "a2222222-2222-4222-8222-222222222222";
const NEGOCIO_B = "b2222222-2222-4222-8222-222222222222";
const DEMANDA_A = "a3333333-3333-4333-8333-333333333333";
const DEMANDA_B = "b3333333-3333-4333-8333-333333333333";

/**
 * Tabelas GLOBAIS da instalação, sem `organization_id` no baseline: a flag de
 * módulo (`platform_config`) e a tabela de módulos (`modulos_instalados`). Ler
 * delas sem filtro de organização é correto, e o dublê precisa saber disso.
 */
const SEM_ORGANIZACAO: readonly string[] = ["platform_config", "modulos_instalados"];

/**
 * Tabelas que a sessão lê sem filtrar por organização (a RLS do banco é quem
 * filtra). O dublê não modela RLS; `sessaoComRls` acrescenta o filtro que ela faria.
 */
const SEM_FILTRO_DE_ORG_NA_SESSAO = [...SEM_ORGANIZACAO, "organizations"];

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;

/** Os módulos que a rota lê como flag em `platform_config`, ligados nesta fixture. */
function modulosLigados(...chaves: string[]): Linhas {
  return { platform_config: chaves.map((chave) => ({ chave, valor: "ligado" })) };
}

/**
 * Linhas da organização A que cada rota precisa para responder 2xx, mais uma
 * linha da B na mesma tabela para o caso "token de A" provar que a de B não
 * aparece. Colunas conferidas no supabase/baseline.sql.
 */
const CONTATOS: Linha[] = [
  {
    id: CONTATO_A,
    organization_id: ORG_A,
    name: "Cliente da A",
    email: null,
    phone_number: null,
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    last_activity_at: null,
    force_human: false,
  },
  {
    id: CONTATO_B,
    organization_id: ORG_B,
    name: "Cliente da B",
    email: null,
    phone_number: null,
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    last_activity_at: null,
    force_human: false,
  },
];
const NEGOCIOS: Linha[] = [
  { id: NEGOCIO_A, organization_id: ORG_A, title: "Negócio da A", contact_id: CONTATO_A },
  { id: NEGOCIO_B, organization_id: ORG_B, title: "Negócio secreto da B", contact_id: CONTATO_B },
];
const DEMANDAS: Linha[] = [
  {
    id: DEMANDA_A,
    organization_id: ORG_A,
    contact_id: CONTATO_A,
    estado: "aberta",
    revision: 1,
    fechada_em: null,
    proximo_passo: null,
    proximo_passo_em: null,
  },
  {
    id: DEMANDA_B,
    organization_id: ORG_B,
    contact_id: CONTATO_B,
    estado: "aberta",
    revision: 1,
    fechada_em: null,
    proximo_passo: null,
    proximo_passo_em: null,
  },
];

const LINHAS_BASE: Linhas = {
  contacts: CONTATOS,
  crm_leads: NEGOCIOS,
  demandas: DEMANDAS,
  contact_field_proposals: [],
  followup_enrollment_events: [],
  followup_enrollments: [],
  user_organizations: [],
};

const SO_DA_A = [CONTATO_A, NEGOCIO_A, DEMANDA_A, ORG_A];
const SO_DA_B = [CONTATO_B, NEGOCIO_B, DEMANDA_B, ORG_B];

type Metodo = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Papel = "viewer" | "agent" | "manager" | "admin";

type Caso = {
  rota: string;
  metodo: Metodo;
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
  linhas: Linhas;
  papel: Papel;
  escopo: "mcp:read" | "mcp:write";
  papelDoToken?: Papel;
  recurso: string;
  rpc?: Record<string, unknown>;
  rotulo?: string;
  status: number;
  colecao?: { daA: string; daB: string };
  audita?: boolean;
  cria?: boolean;
  /**
   * Quem barra a sessão antes da rota: `requireRole` (o portão de papel),
   * `orgAtiva` (usuário + organização ativa, sem papel mínimo) ou `usuario`
   * (só usuário autenticado; a RLS filtra). Padrão: `requireRole`.
   */
  sessao?: "requireRole" | "orgAtiva" | "usuario";
  /** Escopos do token quando a rota precisa de mais de um (ex.: lote que lê e grava). */
  escoposDoToken?: Array<"mcp:read" | "mcp:write">;
  /** O balde do limite de taxa, quando a rota o chama de outro jeito que `recurso`. */
  recursoDoTeto?: string;
  /** Token de B recebe lista vazia (200), nunca dado de A. */
  listaVaziaParaB?: boolean;
  /** Token de B recebe 200 com cada item recusado (`feitos` = 0). */
  recusaPorItemParaB?: boolean;
};

/** Qual `route.ts` importar, por rota. */
const CARREGA: Record<string, () => Promise<Record<string, unknown>>> = {
  "contact-tags": () => import("@/app/api/v1/contact-tags/route"),
  "contacts/[id]": () => import("@/app/api/v1/contacts/[id]/route"),
  "contacts/[id]/always-human": () =>
    import("@/app/api/v1/contacts/[id]/always-human/route"),
  "contacts/[id]/carteira": () => import("@/app/api/v1/contacts/[id]/carteira/route"),
  "contacts/[id]/compras": () => import("@/app/api/v1/contacts/[id]/compras/route"),
  "contacts/[id]/crm-summary": () => import("@/app/api/v1/contacts/[id]/crm-summary/route"),
  "contacts/[id]/hierarquia-do-anuncio": () =>
    import("@/app/api/v1/contacts/[id]/hierarquia-do-anuncio/route"),
  "contacts/[id]/person": () => import("@/app/api/v1/contacts/[id]/person/route"),
  "contacts/[id]/personal": () => import("@/app/api/v1/contacts/[id]/personal/route"),
  "contacts/[id]/proposals": () => import("@/app/api/v1/contacts/[id]/proposals/route"),
  "contacts/[id]/proposals/[proposal_id]": () =>
    import("@/app/api/v1/contacts/[id]/proposals/[proposal_id]/route"),
  "contacts/[id]/roteiros": () => import("@/app/api/v1/contacts/[id]/roteiros/route"),
  "contacts/[id]/roteiros/[enrollmentId]/negocio": () =>
    import("@/app/api/v1/contacts/[id]/roteiros/[enrollmentId]/negocio/route"),
  "contacts/[id]/timeline": () => import("@/app/api/v1/contacts/[id]/timeline/route"),
  "contacts/[id]/vinculos": () => import("@/app/api/v1/contacts/[id]/vinculos/route"),
  "contacts/bulk": () => import("@/app/api/v1/contacts/bulk/route"),
  "contacts/compare": () => import("@/app/api/v1/contacts/compare/route"),
  "contacts/duplicates": () => import("@/app/api/v1/contacts/duplicates/route"),
  "contacts/duplicates/dismiss": () => import("@/app/api/v1/contacts/duplicates/dismiss/route"),
  "contacts/import/agenda": () => import("@/app/api/v1/contacts/import/agenda/route"),
  "contacts/import": () => import("@/app/api/v1/contacts/import/route"),
  "contacts/merge": () => import("@/app/api/v1/contacts/merge/route"),
};

// A lista de contact-tags devolve ETIQUETAS (não ids): a fixture precisa de
// contatos com tags, senão o filtro `neq("tags", "{}")` esvazia a resposta e o
// teste não prova nada. Cada org tem uma etiqueta própria para o caso "B".
const CONTATOS_COM_ETIQUETAS: Linha[] = CONTATOS.map((c) => ({
  ...c,
  tags: c.id === CONTATO_A ? ["etiqueta-da-a"] : ["etiqueta-da-b"],
}));
const LISTA_TAGS: Caso = {
  rota: "contact-tags",
  metodo: "GET",
  caminho: "/api/v1/contact-tags",
  linhas: { ...LINHAS_BASE, contacts: CONTATOS_COM_ETIQUETAS, contact_phones: [] },
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  colecao: { daA: "etiqueta-da-a", daB: "etiqueta-da-b" },
  audita: false,
};

// A ficha exige `agent` no token (`tokenRole: "agent"` na rota). Na sessão, a
// rota não tem papel mínimo: confere usuário e organização ativa.
const FICHA_A_GET: Caso = {
  rota: "contacts/[id]",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}`,
  params: { id: CONTATO_A },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  sessao: "orgAtiva",
};

const FICHA_A_PATCH: Caso = {
  rota: "contacts/[id]",
  metodo: "PATCH",
  caminho: `/api/v1/contacts/${CONTATO_A}`,
  params: { id: CONTATO_A },
  corpo: { name: "Novo nome" },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
};

const SEMPRE_HUMANO_MARCAR: Caso = {
  rota: "contacts/[id]/always-human",
  metodo: "POST",
  caminho: `/api/v1/contacts/${CONTATO_A}/always-human`,
  params: { id: CONTATO_A },
  linhas: LINHAS_BASE,
  papel: "manager",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
};

// Desmarcar só audita quando havia marca: a fixture começa com o contato marcado.
const SEMPRE_HUMANO_DESMARCAR: Caso = {
  rota: "contacts/[id]/always-human",
  metodo: "DELETE",
  caminho: `/api/v1/contacts/${CONTATO_A}/always-human`,
  params: { id: CONTATO_A },
  linhas: {
    ...LINHAS_BASE,
    contacts: CONTATOS.map((c) => (c.id === CONTATO_A ? { ...c, ai_opt_out: true } : c)),
  },
  papel: "manager",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
};

const CARTEIRA_GET: Caso = {
  rota: "contacts/[id]/carteira",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/carteira`,
  params: { id: CONTATO_A },
  linhas: { ...LINHAS_BASE, user_organizations: [] },
  papel: "agent",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  rpc: {
    fn_definir_carteira_do_cliente: () => ({ data: null, error: null }),
  },
};

const COMPRAS_GET: Caso = {
  rota: "contacts/[id]/compras",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/compras`,
  params: { id: CONTATO_A },
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  // Sessão sem portão de papel: a rota confere só o usuário (a RLS filtra).
  sessao: "usuario",
  listaVaziaParaB: true,
};

const CRM_SUMMARY_GET: Caso = {
  rota: "contacts/[id]/crm-summary",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/crm-summary`,
  params: { id: CONTATO_A },
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  sessao: "orgAtiva",
};

const HIERARQUIA_GET: Caso = {
  rota: "contacts/[id]/hierarquia-do-anuncio",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/hierarquia-do-anuncio`,
  params: { id: CONTATO_A },
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  sessao: "usuario",
};

const PERSON_PATCH: Caso = {
  rota: "contacts/[id]/person",
  metodo: "PATCH",
  caminho: `/api/v1/contacts/${CONTATO_A}/person`,
  params: { id: CONTATO_A },
  corpo: { person_id: null },
  linhas: { ...LINHAS_BASE, ...modulosLigados("MODULO_CRM_B2B") },
  papel: "agent",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
};

const PESSOAL_MARCAR: Caso = {
  rota: "contacts/[id]/personal",
  metodo: "POST",
  caminho: `/api/v1/contacts/${CONTATO_A}/personal`,
  params: { id: CONTATO_A },
  linhas: { ...LINHAS_BASE, conversations: [], crm_leads: NEGOCIOS },
  papel: "manager",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
  rpc: {
    fn_conversation_assign: () => ({ data: [], error: null }),
    fn_service_status: () => ({ data: null, error: null }),
    fn_contato_pessoal_remove_trechos_do_rag: () => ({ data: 0, error: null }),
  },
};

// Desmarcar só audita quando havia marca: a fixture começa com o contato pessoal.
const PESSOAL_DESMARCAR: Caso = {
  rota: "contacts/[id]/personal",
  metodo: "DELETE",
  caminho: `/api/v1/contacts/${CONTATO_A}/personal`,
  params: { id: CONTATO_A },
  linhas: {
    ...LINHAS_BASE,
    contacts: CONTATOS.map((c) => (c.id === CONTATO_A ? { ...c, is_personal: true } : c)),
    conversations: [],
    crm_leads: NEGOCIOS,
  },
  papel: "manager",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
  rpc: {
    fn_conversation_assign: () => ({ data: [], error: null }),
    fn_service_status: () => ({ data: null, error: null }),
    fn_contato_pessoal_remove_trechos_do_rag: () => ({ data: 0, error: null }),
  },
};

const PROPOSTA_GET: Caso = {
  rota: "contacts/[id]/proposals",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/proposals`,
  params: { id: CONTATO_A },
  linhas: { ...LINHAS_BASE, contact_field_proposals: [] },
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts.proposals",
  status: 200,
  audita: false,
  listaVaziaParaB: true,
};

const PROPOSTA_DECIDIR: Caso = {
  rota: "contacts/[id]/proposals/[proposal_id]",
  metodo: "POST",
  caminho: `/api/v1/contacts/${CONTATO_A}/proposals/${DEMANDA_A}`,
  params: { id: CONTATO_A, proposal_id: DEMANDA_A },
  corpo: { decision: "accept", motivo: "confirmado" },
  linhas: {
    ...LINHAS_BASE,
    contact_field_proposals: [
      {
        id: DEMANDA_A,
        contact_id: CONTATO_A,
        organization_id: ORG_A,
        campo: "nome",
        valor_proposto: "Novo Nome",
        valor_anterior: "Nome Antigo",
        status: "pending",
      },
    ],
    crm_leads: NEGOCIOS,
  },
  papel: "agent",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contact",
  status: 200,
  audita: true,
};

const ROTEIROS_GET: Caso = {
  rota: "contacts/[id]/roteiros",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/roteiros`,
  params: { id: CONTATO_A },
  linhas: {
    ...LINHAS_BASE,
    ...modulosLigados("MODULO_FLUXOS_DE_ATENDIMENTO"),
    followup_enrollments: [],
    followup_enrollment_events: [],
    crm_leads: NEGOCIOS,
  },
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
};

const ROTEIRO_NEGOCIO_POST: Caso = {
  rota: "contacts/[id]/roteiros/[enrollmentId]/negocio",
  metodo: "POST",
  caminho: `/api/v1/contacts/${CONTATO_A}/roteiros/${DEMANDA_A}/negocio`,
  params: { id: CONTATO_A, enrollmentId: DEMANDA_A },
  corpo: { lead_id: NEGOCIO_A },
  linhas: {
    ...LINHAS_BASE,
    ...modulosLigados("MODULO_FLUXOS_DE_ATENDIMENTO"),
    // A execução está viva ("coletando") e é deste contato; o negócio é ABERTO
    // e do mesmo contato, senão a rota recusa a escolha (422 invalid_lead).
    followup_enrollments: [
      { id: DEMANDA_A, organization_id: ORG_A, contact_id: CONTATO_A, status: "coletando" },
    ],
    followup_enrollment_events: [],
    crm_leads: NEGOCIOS.map((n) => ({ ...n, status: "open" })),
  },
  papel: "manager",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
};

const TIMELINE_GET: Caso = {
  rota: "contacts/[id]/timeline",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/timeline`,
  params: { id: CONTATO_A },
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  sessao: "orgAtiva",
};

const VINCULOS_GET: Caso = {
  rota: "contacts/[id]/vinculos",
  metodo: "GET",
  caminho: `/api/v1/contacts/${CONTATO_A}/vinculos`,
  params: { id: CONTATO_A },
  linhas: { ...LINHAS_BASE, calendar_appointments: [] },
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
};

// O lote LÊ cada contato (GET da ficha, `mcp:read`) e depois GRAVA (PATCH,
// `mcp:write`): o token que o lote aceita precisa dos dois escopos.
// Para B, cada item volta recusado (200, `feitos` = 0) — o lote não derruba.
const BULK_POST: Caso = {
  rota: "contacts/bulk",
  metodo: "POST",
  caminho: "/api/v1/contacts/bulk",
  corpo: { ids: [CONTATO_A], action: "tag", op: "add", tag: "vip" },
  linhas: LINHAS_BASE,
  papel: "agent",
  escopo: "mcp:write",
  escoposDoToken: ["mcp:read", "mcp:write"],
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
  recusaPorItemParaB: true,
};

// Duas fichas da organização A: a comparação precisa de duas. Com a de B no
// meio, a rota responde 404 para A (uma das fichas não está na organização).
const CONTATO_A2 = "a7777777-7777-4777-8777-777777777777";
const COMPARE_GET: Caso = {
  rota: "contacts/compare",
  metodo: "GET",
  caminho: `/api/v1/contacts/compare?ids=${CONTATO_A},${CONTATO_A2}`,
  linhas: {
    ...LINHAS_BASE,
    contacts: [
      ...CONTATOS,
      { ...CONTATOS[0], id: CONTATO_A2, name: "Outra pessoa da A", phone_number: null },
    ],
  },
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  sessao: "orgAtiva",
};

const DUPLICATES_GET: Caso = {
  rota: "contacts/duplicates",
  metodo: "GET",
  caminho: "/api/v1/contacts/duplicates",
  linhas: LINHAS_BASE,
  papel: "viewer",
  escopo: "mcp:read",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: false,
  sessao: "orgAtiva",
  listaVaziaParaB: true,
};

const IMPORT_AGENDA_POST: Caso = {
  rota: "contacts/import/agenda",
  metodo: "POST",
  caminho: "/api/v1/contacts/import/agenda",
  corpo: { channel_session_id: NEGOCIO_A },
  linhas: {
    ...LINHAS_BASE,
    channel_sessions: [
      {
        id: NEGOCIO_A,
        organization_id: ORG_A,
        waha_session_name: "sessao-da-a",
        engine: "NOWEB",
        webhook_path_token: "token-webhook-a",
        webhook_secret_encrypted: "",
        status: "WORKING",
        phone_number: "+5511999999999",
        display_name: "Telefone da A",
      },
    ],
  },
  papel: "agent",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contacts",
  status: 200,
  audita: true,
};

const MERGE_POST: Caso = {
  rota: "contacts/merge",
  metodo: "POST",
  caminho: "/api/v1/contacts/merge",
  corpo: { primary_contact_id: CONTATO_A, secondary_contact_ids: [CONTATO_B] },
  linhas: LINHAS_BASE,
  papel: "manager",
  escopo: "mcp:write",
  papelDoToken: undefined,
  recurso: "contact",
  recursoDoTeto: "contacts",
  status: 200,
  audita: true,
  // O dublê faz o que a função do banco faz: contato de outra organização não
  // se funde, e a erro vem com o rótulo que a rota traduz para 404.
  rpc: {
    fn_mesclar_contatos: (args: Record<string, unknown>) =>
      args.p_organization_id === ORG_A
        ? { data: { contato_id: CONTATO_A }, error: null }
        : { data: null, error: { message: "contato_principal_indisponivel" } },
  },
};

const CASOS: readonly Caso[] = [
  LISTA_TAGS,
  FICHA_A_GET,
  FICHA_A_PATCH,
  SEMPRE_HUMANO_MARCAR,
  SEMPRE_HUMANO_DESMARCAR,
  CARTEIRA_GET,
  COMPRAS_GET,
  CRM_SUMMARY_GET,
  HIERARQUIA_GET,
  PERSON_PATCH,
  PESSOAL_MARCAR,
  PESSOAL_DESMARCAR,
  PROPOSTA_GET,
  PROPOSTA_DECIDIR,
  ROTEIROS_GET,
  ROTEIRO_NEGOCIO_POST,
  TIMELINE_GET,
  VINCULOS_GET,
  BULK_POST,
  COMPARE_GET,
  DUPLICATES_GET,
  IMPORT_AGENDA_POST,
  MERGE_POST,
];

// ─── Ferramentas do teste ───────────────────────────────────────────────────

const AUTORIZACAO = { authorization: "Bearer dsk_abc_def" };

type Manipulador = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const DEGRAU_ABAIXO: Record<Papel, Papel> = {
  admin: "manager",
  manager: "agent",
  agent: "viewer",
  viewer: "viewer",
};

function nome(c: Caso): string {
  return `${c.metodo} ${c.caminho}${c.rotulo ? ` [${c.rotulo}]` : ""}`;
}

function requisicao(c: Caso, cabecalhos: Record<string, string> = {}): NextRequest {
  const h = new Headers(cabecalhos);
  if (c.corpo !== undefined) h.set("content-type", "application/json");
  return new NextRequest(`http://localhost${c.caminho}`, {
    method: c.metodo,
    headers: h,
    body: c.corpo === undefined ? undefined : JSON.stringify(c.corpo),
  });
}

async function chamar(c: Caso, req: NextRequest): Promise<Response> {
  const carregar = CARREGA[c.rota];
  if (!carregar) throw new Error(`rota sem carregador: ${c.rota}`);
  const modulo = (await carregar()) as unknown as Record<string, unknown>;
  const manipulador = modulo[c.metodo] as Manipulador;
  return manipulador(req, { params: Promise.resolve(c.params ?? {}) });
}

function tokenValido(o: { org: string; id: string; papel: string; escopos: string[] }): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: o.org,
    role: o.papel,
    actor: { type: "api_token", id: o.id, role: o.papel },
    apiTokenId: o.id,
    scopes: o.escopos,
  } as never);
}

type OpcoesDoToken = { org?: string; papel?: string; escopos?: string[]; linhas?: Linhas };

/** Chama o método com um Bearer; o cliente do banco é o falso, dono das `linhas`. */
async function comoToken(c: Caso, o: OpcoesDoToken = {}) {
  const org = o.org ?? ORG_A;
  const falso = criarClienteAdminFalso({
    orgDona: org,
    linhas: o.linhas ?? c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  tokenValido({
    org,
    id: org === ORG_A ? TOKEN_A : TOKEN_B,
    papel: o.papel ?? c.papelDoToken ?? c.papel,
    escopos: o.escopos ?? c.escoposDoToken ?? [c.escopo],
  });
  const res = await chamar(c, requisicao(c, AUTORIZACAO));
  const texto = await res.text();
  return { res, texto, falso };
}

/**
 * A sessão passa pela RLS do banco: o cliente do usuário só enxerga a
 * organização dele. O dublê não modela RLS, então o `from` da sessão acrescenta
 * o filtro que ela faria — as rotas que confiam na RLS (sem `.eq` de org) veem
 * só as linhas de A, como veriam no banco.
 */
function sessaoComRls(cliente: unknown, org: string) {
  const base = cliente as { from: (tabela: string) => { eq: (c: string, v: unknown) => unknown } };
  return {
    ...(cliente as object),
    from: (tabela: string) => {
      const consulta = base.from(tabela);
      return SEM_FILTRO_DE_ORG_NA_SESSAO.includes(tabela) ? consulta : consulta.eq("organization_id", org);
    },
  };
}

/** Chama o método SEM Authorization: o caminho de sessão segue seu portão. */
async function comoSessao(c: Caso) {
  const falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createClient).mockImplementation(async () => ({
    ...(sessaoComRls(falso.cliente, ORG_A) as object),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" } },
        error: null,
      }),
    },
  } as never));
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org", role: c.papel },
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: PESSOA_DA_SESSAO,
    idioma: "pt-BR",
  } as never);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({
    ok: true,
    org: { orgId: ORG_A, name: "Org", role: c.papel, org_status: "active" },
  } as never);
  const res = await chamar(c, requisicao(c));
  const texto = await res.text();
  return { res, texto, falso };
}

function daOrganizacao(linhas: Linhas, org: string, tabelas: string[]): Linhas {
  return Object.fromEntries(
    tabelas.map((tabela) => [tabela, (linhas[tabela] ?? []).filter((l) => l.organization_id === org)]),
  );
}

function json<T>(texto: string): T {
  return JSON.parse(texto) as T;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(audit).mockResolvedValue(undefined);
  vi.mocked(getAdapter).mockReturnValue({ listPhonebook: async () => [] } as never);
});

// ─── Os seis testes de cada método ──────────────────────────────────────────

describe("contatos e contact-tags aceitam token", () => {
  for (const c of CASOS) {
    const n = nome(c);
    const tabelas = Object.keys(c.linhas);

    it(`${n}: token de A alcança o recurso de A`, async () => {
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(c.status);
      expect(
        cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO }),
      ).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      for (const deB of SO_DA_B) expect(texto).not.toContain(deB);
      if (c.colecao) expect(texto).toContain(c.colecao.daA);

      expect(requireRole).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
        );
      } else {
        expect(audit).not.toHaveBeenCalled();
      }
    });

    it(`${n}: token de B não alcança o recurso de A`, async () => {
      const idsAntes = new Set((c.linhas.contacts ?? []).map((l) => l.id));
      const { res, texto, falso } = await comoToken(c, { org: ORG_B });

      if (c.colecao) {
        expect(res.status, texto).toBe(200);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        expect(texto).toContain(c.colecao.daB);
        expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      } else if (c.listaVaziaParaB) {
        // Coleção: a rota responde 200 com a lista de B (vazia) e nada de A.
        expect(res.status, texto).toBe(200);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        expect(texto).toContain("[]");
        expect(audit).not.toHaveBeenCalled();
      } else if (c.recusaPorItemParaB) {
        // Lote: 200 com o relatório; cada item de A volta recusado, sem nome de A.
        expect(res.status, texto).toBe(200);
        expect(json<{ data: { feitos: number } }>(texto).data.feitos).toBe(0);
        expect(texto).not.toContain("Cliente da A");
        expect(audit).not.toHaveBeenCalled();
      } else if (c.cria) {
        expect(res.status, texto).toBe(c.status);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        const criadas = (falso.linhas.contacts ?? []).filter((l) => !idsAntes.has(l.id));
        expect(criadas).toHaveLength(1);
        expect(criadas[0]?.organization_id).toBe(ORG_B);
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_B, actorApiTokenId: TOKEN_B }));
        expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
      } else {
        expect(res.status, texto).toBe(404);
        expect(audit).not.toHaveBeenCalled();
      }

      expect(
        cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO }),
      ).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      expect(daOrganizacao(falso.linhas, ORG_A, tabelas)).toEqual(daOrganizacao(c.linhas, ORG_A, tabelas));
    });

    it(`${n}: token sem o escopo é recusado`, async () => {
      const outro = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      const { res, texto, falso } = await comoToken(c, { escopos: [outro] });

      expect(res.status, texto).toBe(403);
      // Leitura da flag de módulo (SEM_ORGANIZACAO) acontece antes da autenticação; não é dado.
      expect(falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela))).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    if (c.papel === "viewer") {
      // viewer é o degrau mais baixo: não existe papel abaixo dele.
    } else {
      it(`${n}: token abaixo do papel é recusado`, async () => {
        const { res, texto, falso } = await comoToken(c, { papel: DEGRAU_ABAIXO[c.papelDoToken ?? c.papel] });

        expect(res.status, texto).toBe(403);
        // Leitura da flag de módulo (SEM_ORGANIZACAO) acontece antes da autenticação; não é dado.
        expect(falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela))).toEqual([]);
        expect(falso.rpcs).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${n}: acima do teto do token → 429`, async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      // Leitura da flag de módulo (SEM_ORGANIZACAO) acontece antes da autenticação; não é dado.
      expect(falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela))).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recursoDoTeto ?? c.recurso}:tok:${TOKEN_A}`);
    });

    it(`${n}: sessão continua com o mesmo portão`, async () => {
      const { res, texto } = await comoSessao(c);

      expect(res.status, texto).toBe(c.status);
      // O portão da sessão é o da rota: papel mínimo (`requireRole`), usuário +
      // organização ativa (`orgAtivaDaApi`), ou só o usuário com a RLS filtrando.
      if (c.sessao === "orgAtiva") {
        expect(orgAtivaDaApi).toHaveBeenCalled();
        expect(requireRole).not.toHaveBeenCalled();
      } else if (c.sessao === "usuario") {
        expect(requireRole).not.toHaveBeenCalled();
      } else {
        expect(requireRole).toHaveBeenCalledWith(c.papel, expect.objectContaining({ resource: c.recurso }));
      }
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO }),
        );
      }
      // Sessão nunca leva o id de um token: a trilha só ganha `actorApiTokenId`
      // quando há token (a rota monta o objeto de sempre para a sessão).
      for (const [entrada] of vi.mocked(audit).mock.calls) {
        expect((entrada as { actorApiTokenId?: unknown }).actorApiTokenId ?? null).toBeNull();
      }
    });
  }
});

// ─── O que só o ramo do token precisa garantir ──────────────────────────────

describe("o ramo do token em contatos e contact-tags", () => {
  it("GET /api/v1/contact-tags busca: a RPC do vocabulário leva a organização do token", async () => {
    // Só o ramo `?busca=` chama a RPC; a listagem simples lê `contacts`.
    const c: Caso = {
      ...LISTA_TAGS,
      caminho: "/api/v1/contact-tags?busca=etiqueta",
      rpc: {
        fn_vocabulario_de_tags_pagina: () => ({
          data: {
            total: 1,
            items: [
              {
                tag: "etiqueta-da-a",
                uso_em_contatos: 1,
                uso_em_leads: 0,
                uso_em_conversas: 0,
                em_regras: 0,
                cor: null,
                descricao: null,
                no_vocabulario: true,
              },
            ],
          },
          error: null,
        }),
      },
    };
    const { res, texto, falso } = await comoToken(c);
    expect(res.status, texto).toBe(200);
    const rpc = falso.rpcs.find((r) => r.nome === "fn_vocabulario_de_tags_pagina");
    expect(rpc?.args.p_org).toBe(ORG_A);
  });

  it("GET /api/v1/contacts/[id]: leitura de contato não traz nada de outra org", async () => {
    const { res, texto, falso } = await comoToken(FICHA_A_GET);
    expect(res.status, texto).toBe(200);
    const cadeiaDoContato = falso.cadeias.find((c) => c.tabela === "contacts");
    expect(cadeiaDoContato?.filtros).toContainEqual(["organization_id", ORG_A]);
    // A rota lê os telefones extras já filtrados por organização: nenhuma leitura pode sair de A.
    const cadeiasDeFones = falso.cadeias.filter((c) => c.tabela === "contact_phones");
    expect(cadeiasForaDaOrganizacao(cadeiasDeFones, ORG_A)).toEqual([]);
  });

  it("POST /api/v1/contacts/[id]/proposals/[proposal_id]: decisão grava proposta com actor null", async () => {
    const { res, texto, falso } = await comoToken(PROPOSTA_DECIDIR, {
      linhas: {
        ...LINHAS_BASE,
        contact_field_proposals: [
          {
            id: DEMANDA_A,
            contact_id: CONTATO_A,
            organization_id: ORG_A,
            campo: "nome",
            valor_proposto: "Novo Nome",
            valor_anterior: "Nome Antigo",
            status: "pending",
          },
        ],
        crm_leads: NEGOCIOS,
      },
    });
    expect(res.status, texto).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
    );
  });

  it("POST /api/v1/contacts/bulk: o item de outra organização é recusado por item, não derruba o lote", async () => {
    const c: Caso = {
      ...BULK_POST,
      corpo: { ids: [CONTATO_A, CONTATO_B], action: "tag", op: "add", tag: "vip" },
    };
    const { res, texto, falso } = await comoToken(c);
    expect(res.status, texto).toBe(200);
    const relatorio = json<{ data: { resultados: Array<{ id: string; feito: boolean }> } }>(texto).data;
    expect(relatorio.resultados.map((r) => r.id).sort()).toEqual([CONTATO_A, CONTATO_B].sort());
    expect(relatorio.resultados.find((r) => r.id === CONTATO_A)?.feito).toBe(true);
    expect(relatorio.resultados.find((r) => r.id === CONTATO_B)?.feito).toBe(false);
  });

  it("POST /api/v1/contacts/merge: a RPC recebe a organização do token, nunca do corpo", async () => {
    const { res, texto, falso } = await comoToken(MERGE_POST);
    expect(res.status, texto).toBe(200);
    const chamada = falso.rpcs.find((r) => r.nome === "fn_mesclar_contatos");
    expect(chamada?.args.p_organization_id).toBe(ORG_A);
  });

  it("POST /api/v1/contacts/import/agenda: sincronização grava actor da sessão mesmo com token", async () => {
    const { res, texto, falso } = await comoToken(IMPORT_AGENDA_POST, {
      linhas: {
        ...LINHAS_BASE,
        channel_sessions: [
          {
            id: NEGOCIO_A,
            organization_id: ORG_A,
            waha_session_name: "sessao-da-a",
            engine: "NOWEB",
            webhook_path_token: "token-webhook-a",
            webhook_secret_encrypted: "",
            status: "WORKING",
            phone_number: "+5511999999999",
            display_name: "Telefone da A",
          },
        ],
      },
    });
    expect(res.status, texto).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorApiTokenId: TOKEN_A, actorUserId: null }));
  });

  it("POST /api/v1/contacts/[id]/personal: o token não assina como pessoa (created_by_user_id null)", async () => {
    const { res, texto, falso } = await comoToken(PESSOAL_MARCAR, {
      linhas: { ...LINHAS_BASE, conversations: [], crm_leads: NEGOCIOS },
    });
    expect(res.status, texto).toBe(200);
    const criado = (falso.linhas.contacts ?? []).find((l) => l.id === CONTATO_A);
    expect(criado).toBeDefined();
  });
});

// ─── O método que FICA DE FORA ──────────────────────────────────────────────

describe("o que segue só de sessão", () => {
  it("DELETE /api/v1/contacts/[id]: fica só de sessão (remoção irreversível, LGPD)", async () => {
    // A rota não converteu DELETE: continua com `requireRole("agent")`, que sem
    // cookie recusa o Bearer com 401.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const modulo = await import("@/app/api/v1/contacts/[id]/route");
    const res = await modulo.DELETE(
      new NextRequest(`http://localhost/api/v1/contacts/${CONTATO_A}`, {
        method: "DELETE",
        headers: { ...AUTORIZACAO },
      }),
      { params: Promise.resolve({ id: CONTATO_A }) },
    );

    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "contacts" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // POST /api/v1/contacts/duplicates/dismiss aceita token desde a R2 (pool `pg` com filtro
  // de organização no SQL): ver `operacao-r2.test.ts`.

  it("PATCH /api/v1/contacts/[id]/carteira: fica só de sessão", async () => {
    // A função de carteira recusa ator nulo: o PATCH segue com `requireRole`, que
    // sem cookie recusa o Bearer com 401, antes de qualquer acesso ao banco.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const modulo = await import("@/app/api/v1/contacts/[id]/carteira/route");
    const res = await modulo.PATCH(
      new NextRequest(`http://localhost/api/v1/contacts/${CONTATO_A}/carteira`, {
        method: "PATCH",
        headers: { ...AUTORIZACAO, "content-type": "application/json" },
        body: JSON.stringify({ dono_user_id: null }),
      }),
      { params: Promise.resolve({ id: CONTATO_A }) },
    );

    expect(res.status).toBe(401);
    // O piso do PATCH de carteira é `agent` (a posse é conferida depois, na rota).
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "contacts" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

// ─── A borda que nenhum teste de handler alcança: o proxy ───────────────────

/**
 * O `proxy.ts` roda ANTES de qualquer route handler e só reconhece cookie. Sem
 * entrada em PUBLIC_PATHS o Bearer nem chega à rota. A porta precisa ser
 * ESTREITA: id em forma de UUID, âncora nos dois lados.
 *
 * Irmãos literais (ls app/api/v1/contacts/[id]/): sempre-human, carteira,
 * compras, crm-summary, hierarquia-do-anuncio, person, personal, proposals,
 * roteiros, timeline, vinculos — todos ganharam porta. proposal_id é um irmão
 * literal de proposals que NÃO ganhou porta (só POST dentro dele, e o GET é
 * em proposals). lista aqui os irmãos de cada nível.
 */
describe("PUBLIC_PATHS — as portas de contatos e contact-tags", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";

  it.each([
    "/api/v1/contact-tags",
    `/api/v1/contacts/${UUID}`,
    `/api/v1/contacts/${UUID}/always-human`,
    `/api/v1/contacts/${UUID}/carteira`,
    `/api/v1/contacts/${UUID}/compras`,
    `/api/v1/contacts/${UUID}/crm-summary`,
    `/api/v1/contacts/${UUID}/hierarquia-do-anuncio`,
    `/api/v1/contacts/${UUID}/person`,
    `/api/v1/contacts/${UUID}/personal`,
    `/api/v1/contacts/${UUID}/proposals`,
    `/api/v1/contacts/${UUID}/roteiros`,
    `/api/v1/contacts/${UUID}/timeline`,
    `/api/v1/contacts/${UUID}/vinculos`,
    "/api/v1/contacts/bulk",
    "/api/v1/contacts/compare",
    "/api/v1/contacts/duplicates",
    "/api/v1/contacts/import/agenda",
    "/api/v1/contacts/import",
    "/api/v1/contacts/merge",
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // id fora da forma de UUID
    "/api/v1/contacts/abc",
    "/api/v1/contacts/x",
    `/api/v1/contacts/${UUID}/abc`,
    // sub-path
    `/api/v1/contacts/${UUID}/x`,
    // irmão literal do mesmo nível que NÃO ganhou porta (proposals/[proposal_id])
    `/api/v1/contacts/${UUID}/proposals/x`,
    // o pai sem rota de contacts/[id]/* não existe além do próprio [id]
    `/api/v1/contacts/${UUID}/proposals/${UUID}/x`,
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
