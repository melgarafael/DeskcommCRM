// @vitest-environment node
/**
 * LEADS E LEAD-CAPTURES ACEITAM TOKEN (Spec 33, fatia R2, tarefa 3).
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
 * o método que FICA DE FORA (leads/[id]/conversion/retry), e a borda do proxy.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole, orgAtivaDaApi } from "@/lib/auth/require-role";
import { loadAuthUser, requireAuth } from "@/lib/auth/server";
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
  requireAuth: vi.fn(async () => {
    throw new Error("requireAuth chamado no ramo do token");
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

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const PESSOA_DA_SESSAO = "c0000000-0000-4000-8000-000000000001";

const LEAD_A = "a1111111-1111-4111-8111-111111111111";
const LEAD_B = "b1111111-1111-4111-8111-bbbbbbbbbbbb";
const CONTATO_A = "a2222222-2222-4222-8222-222222222222";
const CONTATO_B = "b2222222-2222-4222-8222-bbbbbbbbbbbb";
const PIPELINE_A = "a3333333-3333-4333-8333-aaaaaaaaaaaa";
const PIPELINE_B = "b3333333-3333-4333-8333-bbbbbbbbbbbb";
/** Um SEGUNDO funil da organização A: destino do clone (o da B não serve a A). */
const PIPELINE_A_DESTINO = "a3333333-3333-4333-8333-aaaaaaaaaac2";
const ETAPA_A = "a4444444-4444-4444-8444-aaaaaaaaaaaa";
const ETAPA_B = "b4444444-4444-4444-8444-bbbbbbbbbbbb";
const ETAPA_A_DESTINO = "a4444444-4444-4444-8444-aaaaaaaaaac3";
const CONTATO_A_SEGUNDO = "a2222222-2222-4222-8222-aaaaaaaaaaa2";
const ANEXO_A = "a5555555-5555-4555-8555-aaaaaaaaaaaa";
const PROPOSTA_A = "a6666666-6666-4666-8666-aaaaaaaaaaaa";
const LINK_A = "a7777777-7777-4777-8777-aaaaaaaaaaaa";

const SEM_ORGANIZACAO = [] as const;

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;

/**
 * Linhas da organização A que cada rota precisa para responder 2xx, mais uma
 * linha da B na mesma tabela para o caso "token de A" provar que a de B não
 * aparece. Colunas conferidas no supabase/baseline.sql.
 */
const LEADS: Linha[] = [
  {
    id: LEAD_A,
    organization_id: ORG_A,
    pipeline_id: PIPELINE_A,
    stage_id: ETAPA_A,
    title: "Negócio da A",
    contact_id: CONTATO_A,
    status: "open",
    value_cents: 10000,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    tags: [],
    source: "manual",
    custom_fields: {},
    lost_reason: null,
    won_reason: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    last_activity_at: null,
    position_in_stage: 1,
    expected_close_date: null,
    recurring_value_cents: null,
    recurring_period: null,
    recurring_months: null,
    source_metadata: {},
  },
  {
    id: LEAD_B,
    organization_id: ORG_B,
    pipeline_id: PIPELINE_B,
    stage_id: ETAPA_B,
    title: "Negócio secreto da B",
    contact_id: CONTATO_B,
    status: "open",
    value_cents: 20000,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    tags: [],
    source: "manual",
    custom_fields: {},
    lost_reason: null,
    won_reason: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    last_activity_at: null,
    position_in_stage: 1,
    expected_close_date: null,
    recurring_value_cents: null,
    recurring_period: null,
    recurring_months: null,
    source_metadata: {},
  },
];
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
    id: CONTATO_A_SEGUNDO,
    organization_id: ORG_A,
    name: "Segundo contato da A",
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
/**
 * Funil da A com o campo que as rotas de proposta e de anexo consultam em
 * `settings.fields` (escopo padrão = negócio): `nome` (texto, da proposta) e
 * `contrato` (arquivo, do anexo). Sem eles a régua do funil recusa com
 * `campo_fora_do_funil` / "não tem um campo de arquivo com essa chave".
 */
const PIPELINES: Linha[] = [
  {
    id: PIPELINE_A,
    organization_id: ORG_A,
    name: "Funil da A",
    settings: {
      fields: [
        { key: "nome", label: "Nome", type: "text" },
        { key: "contrato", label: "Contrato", type: "file" },
      ],
    },
  },
  { id: PIPELINE_A_DESTINO, organization_id: ORG_A, name: "Funil de destino da A", settings: {} },
  { id: PIPELINE_B, organization_id: ORG_B, name: "Funil secreto da B", settings: {} },
];
const ETAPAS: Linha[] = [
  { id: ETAPA_A, organization_id: ORG_A, pipeline_id: PIPELINE_A, name: "Etapa da A", is_won: false, is_lost: false, is_archived: false, position: 1 },
  { id: "a4444444-4444-4444-8444-aaaaaaaaaab1", organization_id: ORG_A, pipeline_id: PIPELINE_A, name: "Ganho da A", is_won: true, is_lost: false, is_archived: false, position: 2 },
  { id: "a4444444-4444-4444-8444-aaaaaaaaaab2", organization_id: ORG_A, pipeline_id: PIPELINE_A, name: "Perda da A", is_won: false, is_lost: true, is_archived: false, position: 3 },
  { id: ETAPA_A_DESTINO, organization_id: ORG_A, pipeline_id: PIPELINE_A_DESTINO, name: "Etapa de destino da A", is_won: false, is_lost: false, is_archived: false, position: 1 },
  { id: ETAPA_B, organization_id: ORG_B, pipeline_id: PIPELINE_B, name: "Etapa da B", is_won: false, is_lost: false, is_archived: false, position: 1 },
];
const ORGS: Linha[] = [
  { id: ORG_A, name: "Org A", settings: {}, created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-01T10:00:00.000Z" },
  { id: ORG_B, name: "Org B", settings: {}, created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-01T10:00:00.000Z" },
];
const ATTACHMENTS: Linha[] = [
  { id: ANEXO_A, organization_id: ORG_A, lead_id: LEAD_A, field_key: "contrato", file_name: "c.pdf", storage_path: `${ORG_A}/leads/${LEAD_A}/contrato/${ANEXO_A}.pdf`, file_size: 1234, mime_type: "application/pdf", created_at: "2026-11-01T10:00:00.000Z" },
  { id: "b5555555-5555-4555-8555-bbbbbbbbbbbb", organization_id: ORG_B, lead_id: LEAD_B, field_key: "contrato", file_name: "s.pdf", storage_path: `${ORG_B}/leads/${LEAD_B}/contrato/b5555555-5555-4555-8555-bbbbbbbbbbbb.pdf`, file_size: 1234, mime_type: "application/pdf", created_at: "2026-11-01T10:00:00.000Z" },
];
const PROPOSALS: Linha[] = [
  { id: PROPOSTA_A, lead_id: LEAD_A, campo: "nome", valor_proposto: "Novo Nome", status: "pending", expires_at: "2026-12-01T10:00:00.000Z", attachment_id: null, organization_id: ORG_A, decided_at: null, decided_by_user_id: null, motivo_recusa: null, valor_anterior: "Nome Antigo" },
];
const LINKS: Linha[] = [
  { id: LINK_A, organization_id: ORG_A, lead_id: LEAD_A, target_id: CONTATO_A, target_kind: "contact", link_kind: "related", metadata: {}, created_at: "2026-11-01T10:00:00.000Z" },
];
const ACTIVITIES: Linha[] = [
  { id: "a8888888-8888-4888-8888-aaaaaaaaaaaa", organization_id: ORG_A, lead_id: LEAD_A, contact_id: CONTATO_A, type: "stage_changed", source_module: "crm", source_id: LEAD_A, actor: { type: "user", id: PESSOA_DA_SESSAO }, reason: "mudou de etapa", payload: {}, performed_at: "2026-11-01T10:00:00.000Z" },
];
const REACTIVATIONS: Linha[] = [
  { id: "a9999999-9999-4999-8999-aaaaaaaaaaaa", organization_id: ORG_A, lead_id: LEAD_A, expires_at: "2026-12-01T10:00:00.000Z", status: "pending", created_at: "2026-11-01T10:00:00.000Z", decided_at: null, decided_by_user_id: null },
];
const EVENTS: Linha[] = [
  { id: "a0000000-0000-4000-8000-aaaaaaaaaaaa", organization_id: ORG_A, event_type: "lead.won", entity_id: LEAD_A, entity_kind: "lead", payload: {}, created_at: "2026-11-01T10:00:00.000Z" },
];
const CRON_JOBS: Linha[] = [];

const LINHAS_BASE: Linhas = {
  crm_leads: LEADS,
  crm_stages: ETAPAS,
  crm_pipelines: PIPELINES,
  contacts: CONTATOS,
  organizations: ORGS,
  crm_lead_attachments: ATTACHMENTS,
  lead_field_proposals: PROPOSALS,
  crm_lead_links: LINKS,
  crm_lead_activities: ACTIVITIES,
  crm_lead_reactivations: REACTIVATIONS,
  event_log: EVENTS,
  cron_jobs: CRON_JOBS,
};

/** Retomar só vale para negócio ENCERRADO (a rota recusa o aberto com 422): a origem da retomada é perdida. */
const LINHAS_RETOMADA: Linhas = {
  ...LINHAS_BASE,
  crm_leads: LEADS.map((l) => (l.id === LEAD_A ? { ...l, status: "lost", lost_reason: "price" } : l)),
};

const SO_DA_A = [LEAD_A, CONTATO_A, PIPELINE_A, ETAPA_A, ORG_A, ANEXO_A, PROPOSTA_A, LINK_A];
const SO_DA_B = [LEAD_B, CONTATO_B, PIPELINE_B, ETAPA_B, ORG_B];

type Metodo = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Papel = "viewer" | "agent" | "manager" | "admin";

type Caso = {
  rota: string;
  metodo: Metodo;
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
  formData?: () => FormData;
  linhas: Linhas;
  papel: Papel;
  escopo: "mcp:read" | "mcp:write";
  papelDoToken?: Papel;
  recurso: string;
  recursoDoTeto?: string;
  rpc?: Record<string, unknown>;
  rotulo?: string;
  status: number;
  /** Status que o token de B recebe quando a rota responde "não achei" (padrão 404). */
  statusDeB?: number;
  colecao?: { daA: string; daB: string };
  /** Resposta igual para toda organização (modelo de planilha): B recebe 200 e nada de A. */
  publico?: boolean;
  /** Coleção escopada pela organização: B recebe 200 com as listas VAZIAS (a fixture de B não tem a coleção). */
  listaDaOrganizacao?: boolean;
  audita?: boolean;
  cria?: boolean;
};

/** Qual `route.ts` importar, por rota. */
const CARREGA: Record<string, () => Promise<Record<string, unknown>>> = {
  "leads": () => import("@/app/api/v1/leads/route"),
  "leads/[id]": () => import("@/app/api/v1/leads/[id]/route"),
  "leads/[id]/win": () => import("@/app/api/v1/leads/[id]/win/route"),
  "leads/[id]/lose": () => import("@/app/api/v1/leads/[id]/lose/route"),
  "leads/[id]/move": () => import("@/app/api/v1/leads/[id]/move/route"),
  "leads/[id]/clone": () => import("@/app/api/v1/leads/[id]/clone/route"),
  "leads/[id]/retomar": () => import("@/app/api/v1/leads/[id]/retomar/route"),
  "leads/[id]/reactivation": () => import("@/app/api/v1/leads/[id]/reactivation/route"),
  "leads/[id]/next-action": () => import("@/app/api/v1/leads/[id]/next-action/route"),
  "leads/[id]/timeline": () => import("@/app/api/v1/leads/[id]/timeline/route"),
  "leads/[id]/eventos": () => import("@/app/api/v1/leads/[id]/eventos/route"),
  "leads/[id]/contatos-relacionados": () => import("@/app/api/v1/leads/[id]/contatos-relacionados/route"),
  "leads/[id]/attachments": () => import("@/app/api/v1/leads/[id]/attachments/route"),
  "leads/[id]/attachments/[attachmentId]/media": () =>
    import("@/app/api/v1/leads/[id]/attachments/[attachmentId]/media/route"),
  "leads/[id]/field-proposals": () => import("@/app/api/v1/leads/[id]/field-proposals/route"),
  "leads/[id]/field-proposals/[pid]": () => import("@/app/api/v1/leads/[id]/field-proposals/[pid]/route"),
  "leads/bulk": () => import("@/app/api/v1/leads/bulk/route"),
  "leads/import": () => import("@/app/api/v1/leads/import/route"),
  "leads/proposals": () => import("@/app/api/v1/leads/proposals/route"),
  "leads/reactivations": () => import("@/app/api/v1/leads/reactivations/route"),
};

const CASOS: readonly Caso[] = [
  // ─── coleções ───

  // POST /api/v1/leads — criação (agent+).
  {
    rota: "leads",
    metodo: "POST",
    caminho: "/api/v1/leads",
    corpo: {
      pipeline_id: PIPELINE_A,
      stage_id: ETAPA_A,
      title: "Novo negócio da A",
      contact_id: CONTATO_A,
    },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_create",
    status: 201,
    cria: true,
    audita: true,
  },
  // POST /api/v1/leads/bulk — move/assign/tag/delete em lote (agent+).
  {
    rota: "leads/bulk",
    metodo: "POST",
    caminho: "/api/v1/leads/bulk",
    corpo: { lead_ids: [LEAD_A], action: "tag", params: { add: ["quente"] } },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_bulk",
    status: 200,
    audita: true,
  },
  // GET /api/v1/leads/import — planilha modelo (agent+).
  // GET /api/v1/leads/import — planilha modelo: o mesmo texto para toda org (agent+).
  {
    rota: "leads/import",
    metodo: "GET",
    caminho: "/api/v1/leads/import",
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_import",
    status: 200,
    publico: true,
    audita: false,
  },
  // POST /api/v1/leads/import — importação de planilha (agent+). Multipart: `file` + `pipeline_id`.
  // Para o token de B o funil de A não tem etapa aberta VISÍVEL: a rota responde 422
  // ("Este funil não tem etapas abertas.") antes de qualquer escrita.
  {
    rota: "leads/import",
    metodo: "POST",
    caminho: "/api/v1/leads/import",
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_import",
    status: 200,
    statusDeB: 422,
    cria: true,
    audita: true,
    formData: () => {
      const fd = new FormData();
      const planilha = new File(
        [
          "nome,nome do contato,telefone,email,valor,origem,tags,observacao\n" +
            'Reforma do apartamento 402,Ana Souza,11988887777,ana@exemplo.com,"12.500,00",indicacao,"quente;retorno",Pediu orcamento para junho\n',
        ],
        "leads.csv",
        { type: "text/csv" },
      );
      fd.set("file", planilha);
      fd.set("pipeline_id", PIPELINE_A);
      return fd;
    },
  },
  // GET /api/v1/leads/proposals — próximas ações da IA (membro/viewer). A lista é da
  // organização: a fixture de B não tem negócio com próxima ação, então a lista é vazia.
  {
    rota: "leads/proposals",
    metodo: "GET",
    caminho: "/api/v1/leads/proposals",
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_proposals",
    status: 200,
    listaDaOrganizacao: true,
    audita: false,
  },
  // GET /api/v1/leads/reactivations — propostas de retomada vivas (viewer+). Lista da organização.
  {
    rota: "leads/reactivations",
    metodo: "GET",
    caminho: "/api/v1/leads/reactivations",
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_reactivations",
    status: 200,
    listaDaOrganizacao: true,
    audita: false,
  },
  // ─── itens [id] ───

  // PATCH /api/v1/leads/[id] — atualização (agent+).
  {
    rota: "leads/[id]",
    metodo: "PATCH",
    caminho: `/api/v1/leads/${LEAD_A}`,
    params: { id: LEAD_A },
    corpo: { title: "Novo título" },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_patch",
    status: 200,
    audita: true,
  },
  // POST /api/v1/leads/[id]/win — ganhar (agent+).
  {
    rota: "leads/[id]/win",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/win`,
    params: { id: LEAD_A },
    corpo: {},
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_win",
    status: 200,
    audita: true,
  },
  // POST /api/v1/leads/[id]/lose — perder (agent+).
  {
    rota: "leads/[id]/lose",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/lose`,
    params: { id: LEAD_A },
    corpo: { lost_reason: "price" },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_lose",
    status: 200,
    audita: true,
  },
  // POST /api/v1/leads/[id]/move — mover de etapa (agent+).
  {
    rota: "leads/[id]/move",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/move`,
    params: { id: LEAD_A },
    corpo: { stage_id: ETAPA_A, position_in_stage: 2, expected_updated_at: "2026-11-01T10:00:00.000Z" },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_move",
    status: 200,
    audita: true,
  },
  // POST /api/v1/leads/[id]/clone — clonar para outro funil (agent+).
  {
    rota: "leads/[id]/clone",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/clone`,
    params: { id: LEAD_A },
    corpo: { pipeline_id: PIPELINE_A_DESTINO },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_clone",
    status: 201,
    cria: true,
    audita: true,
  },
  // GET /api/v1/leads/[id]/clone — destinos disponíveis (agent+).
  {
    rota: "leads/[id]/clone",
    metodo: "GET",
    caminho: `/api/v1/leads/${LEAD_A}/clone`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_clone_view",
    status: 200,
    audita: false,
  },
  // POST /api/v1/leads/[id]/retomar — retomar como novo (agent+).
  {
    rota: "leads/[id]/retomar",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/retomar`,
    params: { id: LEAD_A },
    corpo: { stage_id: ETAPA_A },
    linhas: LINHAS_RETOMADA,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_retomar",
    status: 201,
    cria: true,
    audita: true,
  },
  // POST /api/v1/leads/[id]/reactivation — aceitar/descartar reativação (agent+).
  {
    rota: "leads/[id]/reactivation",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/reactivation`,
    params: { id: LEAD_A },
    corpo: { decision: "accept", proposal_id: REACTIVATIONS[0]?.id as string },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_reactivation",
    status: 200,
    audita: false, // a rota grava na linha do tempo do lead (emitLeadActivity); nunca chamou audit()
  },
  // POST /api/v1/leads/[id]/next-action — aprovar/descartar próxima ação (agent+).
  {
    rota: "leads/[id]/next-action",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/next-action`,
    params: { id: LEAD_A },
    corpo: { decision: "approve", approved_seq: 1 },
    linhas: { ...LINHAS_BASE, lead_state: [{ organization_id: ORG_A, contact_id: CONTATO_A, next_action: "ligar", next_action_seq: 1 }] },
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_next_action",
    status: 200,
    audita: false,
  },
  // GET /api/v1/leads/[id]/timeline — timeline do negócio (membro/viewer).
  {
    rota: "leads/[id]/timeline",
    metodo: "GET",
    caminho: `/api/v1/leads/${LEAD_A}/timeline`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_timeline",
    status: 200,
    audita: false,
  },
  // GET /api/v1/leads/[id]/eventos — eventos de aviso (viewer+).
  {
    rota: "leads/[id]/eventos",
    metodo: "GET",
    caminho: `/api/v1/leads/${LEAD_A}/eventos`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "leads",
    recursoDoTeto: "leads_eventos",
    status: 200,
    audita: false,
  },
  // GET /api/v1/leads/[id]/contatos-relacionados — vínculos do negócio (membro/viewer).
  {
    rota: "leads/[id]/contatos-relacionados",
    metodo: "GET",
    caminho: `/api/v1/leads/${LEAD_A}/contatos-relacionados`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_contatos_relacionados",
    status: 200,
    audita: false,
  },
  // POST /api/v1/leads/[id]/contatos-relacionados — adicionar vínculo (agent+).
  {
    rota: "leads/[id]/contatos-relacionados",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/contatos-relacionados`,
    params: { id: LEAD_A },
    corpo: { contact_id: CONTATO_A_SEGUNDO, papel: "responsável" },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_lead_links",
    recursoDoTeto: "leads_contatos_relacionados",
    status: 201,
    cria: true,
    audita: true,
  },
  // DELETE /api/v1/leads/[id]/contatos-relacionados — remover vínculo (agent+). O contato vai na QUERY.
  {
    rota: "leads/[id]/contatos-relacionados",
    metodo: "DELETE",
    caminho: `/api/v1/leads/${LEAD_A}/contatos-relacionados?contact_id=${CONTATO_A}`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_lead_links",
    recursoDoTeto: "leads_contatos_relacionados",
    status: 200,
    audita: true,
  },
  // GET /api/v1/leads/[id]/attachments — listar anexos (viewer+).
  {
    rota: "leads/[id]/attachments",
    metodo: "GET",
    caminho: `/api/v1/leads/${LEAD_A}/attachments`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_attachments",
    status: 200,
    audita: false,
  },
  // POST /api/v1/leads/[id]/attachments — upload de anexo (agent+).
  {
    rota: "leads/[id]/attachments",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/attachments`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_attachments",
    status: 201,
    cria: true,
    audita: true,
    formData: () => {
      const fd = new FormData();
      fd.set("file", new Blob(["conteudo"], { type: "application/pdf" }), "c.pdf");
      fd.set("field_key", "contrato");
      return fd;
    },
  },
  // DELETE /api/v1/leads/[id]/attachments — remover anexo (agent+).
  {
    rota: "leads/[id]/attachments",
    metodo: "DELETE",
    caminho: `/api/v1/leads/${LEAD_A}/attachments`,
    params: { id: LEAD_A },
    corpo: { field_key: "contrato", attachment_id: ANEXO_A },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_attachments",
    status: 200,
    audita: true,
  },
  // GET /api/v1/leads/[id]/attachments/[attachmentId]/media — abrir anexo (viewer+).
  {
    rota: "leads/[id]/attachments/[attachmentId]/media",
    metodo: "GET",
    caminho: `/api/v1/leads/${LEAD_A}/attachments/${ANEXO_A}/media`,
    params: { id: LEAD_A, attachmentId: ANEXO_A },
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_media",
    // 302 para a URL assinada do Storage (a rota não devolve o arquivo, redireciona).
    status: 302,
    audita: false,
  },
  // GET /api/v1/leads/[id]/field-proposals — fila de revisão (viewer+).
  {
    rota: "leads/[id]/field-proposals",
    metodo: "GET",
    caminho: `/api/v1/leads/${LEAD_A}/field-proposals`,
    params: { id: LEAD_A },
    linhas: LINHAS_BASE,
    papel: "viewer",
    escopo: "mcp:read",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_field_proposals",
    status: 200,
    audita: false,
  },
  // POST /api/v1/leads/[id]/field-proposals/[pid] — aceitar/recusar proposta (agent+).
  {
    rota: "leads/[id]/field-proposals/[pid]",
    metodo: "POST",
    caminho: `/api/v1/leads/${LEAD_A}/field-proposals/${PROPOSTA_A}`,
    params: { id: LEAD_A, pid: PROPOSTA_A },
    corpo: { decision: "accept" },
    linhas: LINHAS_BASE,
    papel: "agent",
    escopo: "mcp:write",
    papelDoToken: undefined,
    recurso: "crm_leads",
    recursoDoTeto: "leads_field_proposals_decision",
    status: 200,
    audita: true,
  },
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
  if (c.formData) {
    // Sem `content-type` manual: o runtime põe o boundary que serializou o corpo.
    // Um boundary inventado aqui não bate com o corpo e o `formData()` recusa.
    const fd = c.formData();
    return new NextRequest(`http://localhost${c.caminho}`, {
      method: c.metodo,
      headers: h,
      body: fd as unknown as BodyInit,
    });
  }
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
    escopos: o.escopos ?? [c.escopo],
  });
  const res = await chamar(c, requisicao(c, AUTORIZACAO));
  const texto = await res.text();
  return { res, texto, falso };
}

/** Chama o método SEM Authorization: o caminho de sessão segue seu portão. */
async function comoSessao(c: Caso) {
  // Na sessão quem filtra por organização é a RLS do banco, que o dublê não
  // simula: as tabelas ficam sem a exigência de `organization_id` (as cadeias
  // continuam filtradas por tudo que a rota escreveu). Este teste confere o
  // PORTÃO da sessão (status, papel, auditoria), não o isolamento de tenant —
  // esse é o de `comoToken`.
  const falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: c.linhas,
    rpc: c.rpc,
    tabelasSemOrganizacao: Object.keys(c.linhas),
  });
  vi.mocked(createClient).mockResolvedValue({
    ...(falso.cliente as object),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" } },
        error: null,
      }),
    },
  } as never);
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
  vi.mocked(requireAuth).mockResolvedValue({
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
});

// ─── Os seis testes de cada método ──────────────────────────────────────────

describe("leads e lead-captures aceitam token", () => {
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
      } else if (c.publico || c.listaDaOrganizacao) {
        // Leitura: 200 para B, sem um byte de A; a lista de B é vazia nesta fixture.
        expect(res.status, texto).toBe(200);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        if (c.listaDaOrganizacao) {
          const corpo = json<{ data: Record<string, unknown[]> }>(texto);
          for (const lista of Object.values(corpo.data)) expect(lista).toEqual([]);
        }
        expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      } else if (c.cria) {
        expect(res.status, texto).toBe(c.statusDeB ?? 404);
        expect(audit).not.toHaveBeenCalled();
        expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      } else {
        expect(res.status, texto).toBe(c.statusDeB ?? 404);
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
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    if (c.papel === "viewer") {
      // viewer é o degrau mais baixo: não existe papel abaixo dele.
    } else {
      it(`${n}: token abaixo do papel é recusado`, async () => {
        const { res, texto, falso } = await comoToken(c, { papel: DEGRAU_ABAIXO[c.papelDoToken ?? c.papel] });

        expect(res.status, texto).toBe(403);
        expect(falso.cadeias).toEqual([]);
        expect(falso.rpcs).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${n}: acima do teto do token → 429`, async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(falso.cadeias).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.recursoDoTeto ?? c.recurso}:tok:${TOKEN_A}`);
    });

    it(`${n}: sessão continua com o mesmo portão`, async () => {
      const { res, texto, falso } = await comoSessao(c);

      expect(res.status, texto).toBe(c.status);
      // Rotas de receita B (contatos-relacionados GET, timeline, proposals) não
      // chamam requireRole na sessão — usam getUser/loadAuthUser/orgAtivaDaApi.
      const usaRequireRoleNaSessao = !(
        (c.rota === "leads/[id]/contatos-relacionados" && c.metodo === "GET") ||
        (c.rota === "leads/[id]/timeline" && c.metodo === "GET") ||
        (c.rota === "leads/proposals" && c.metodo === "GET")
      );
      if (usaRequireRoleNaSessao) {
        expect(requireRole).toHaveBeenCalledWith(c.papel, expect.objectContaining({ resource: c.recurso }));
      }
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null }),
        );
      }
    });
  }
});

// ─── O que só o ramo do token precisa garantir ──────────────────────────────

describe("o ramo do token em leads e lead-captures", () => {
  it("POST /api/v1/leads/[id]/contatos-relacionados: contato de outra org é rejeitado", async () => {
    const c: Caso = {
      ...CASOS.find((x) => x.rota === "leads/[id]/contatos-relacionados" && x.metodo === "POST")!,
      corpo: { contact_id: CONTATO_B, papel: "responsável" },
    };
    const { res, texto, falso } = await comoToken(c, { linhas: { ...LINHAS_BASE, contacts: CONTATOS } });
    expect(res.status, texto).toBe(404);
    expect(falso.linhas.crm_lead_links).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("POST /api/v1/leads/[id]/field-proposals/[pid]: decisão grava com actor null", async () => {
    const c = CASOS.find((x) => x.rota === "leads/[id]/field-proposals/[pid]" && x.metodo === "POST")!;
    const { res, texto, falso } = await comoToken(c, {
      linhas: {
        ...LINHAS_BASE,
        lead_field_proposals: PROPOSALS,
      },
    });
    expect(res.status, texto).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
    );
  });

  it("POST /api/v1/leads/bulk: tag só afeta leads da org do token", async () => {
    const c: Caso = {
      ...CASOS.find((x) => x.rota === "leads/bulk" && x.metodo === "POST")!,
      corpo: { lead_ids: [LEAD_A, LEAD_B], action: "tag", params: { add: ["quente"] } },
    };
    const { res, texto } = await comoToken(c);
    expect(res.status, texto).toBe(200);
    const relatorio = json<{ data: { updated_count: number; lead_ids: string[] } }>(texto).data;
    expect(relatorio.updated_count).toBe(1);
    expect(relatorio.lead_ids).toEqual([LEAD_A]);
  });

  it("POST /api/v1/leads/bulk: assign com token não-gerente é recusado", async () => {
    const c: Caso = {
      ...CASOS.find((x) => x.rota === "leads/bulk" && x.metodo === "POST")!,
      corpo: { lead_ids: [LEAD_A], action: "assign", params: { owner_user_id: PESSOA_DA_SESSAO } },
    };
    const { res, texto } = await comoToken(c, { papel: "agent" });
    expect(res.status, texto).toBe(403);
  });

  it("POST /api/v1/leads/bulk: move com stage_id de outra org é 404", async () => {
    const c: Caso = {
      ...CASOS.find((x) => x.rota === "leads/bulk" && x.metodo === "POST")!,
      corpo: { lead_ids: [LEAD_A], action: "move", params: { stage_id: ETAPA_B } },
    };
    const { res, texto } = await comoToken(c);
    expect(res.status, texto).toBe(404);
  });

  it("POST /api/v1/leads/bulk: delete só remove leads da org do token", async () => {
    const c: Caso = {
      ...CASOS.find((x) => x.rota === "leads/bulk" && x.metodo === "POST")!,
      corpo: { lead_ids: [LEAD_A, LEAD_B], action: "delete" },
    };
    const { res, texto } = await comoToken(c);
    expect(res.status, texto).toBe(200);
    const relatorio = json<{ data: { updated_count: number; lead_ids: string[] } }>(texto).data;
    expect(relatorio.updated_count).toBe(1);
    expect(relatorio.lead_ids).toEqual([LEAD_A]);
  });

  it("GET /api/v1/leads/[id]/eventos: a consulta filtra organization_id", async () => {
    const c = CASOS.find((x) => x.rota === "leads/[id]/eventos" && x.metodo === "GET")!;
    const { res, texto, falso } = await comoToken(c);
    expect(res.status, texto).toBe(200);
    const cadeia = falso.cadeias.find((cad) => cad.tabela === "event_log");
    expect(cadeia?.filtros).toContainEqual(["organization_id", ORG_A]);
  });
});

// ─── O método que FICA DE FORA ──────────────────────────────────────────────

describe("o que segue só de sessão", () => {
  it("POST /api/v1/leads/[id]/conversion/retry: fica só de sessão (nega do plano R2)", async () => {
    // A rota não converteu POST: continua com `requireRole("agent")`, que sem
    // cookie recusa o Bearer com 401.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const modulo = await import("@/app/api/v1/leads/[id]/conversion/retry/route");
    const res = await modulo.POST(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD_A}/conversion/retry`, {
        method: "POST",
        headers: { ...AUTORIZACAO },
      }),
      { params: Promise.resolve({ id: LEAD_A }) },
    );

    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "ad_conversion_dispatches" }),
    );
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // GET /api/v1/leads/at-risk aceita token desde a R2 (receita B): ver `operacao-r2.test.ts`.

  it("GET /api/v1/lead-captures: fica só de sessão", async () => {
    // A rota não converteu GET: continua com `requireRole("manager")`, que sem
    // cookie recusa o Bearer com 401, antes de qualquer acesso ao banco.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const modulo = await import("@/app/api/v1/lead-captures/route");
    const res = await modulo.GET(
      new NextRequest(`http://localhost/api/v1/lead-captures`, {
        method: "GET",
        headers: { ...AUTORIZACAO },
      }),
    );

    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "lead_captures" }),
    );
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

// ─── A borda que nenhum teste de handler alcança: o proxy ───────────────────

/**
 * O `proxy.ts` roda ANTES de qualquer route handler e só reconhece cookie. Sem
 * entrada em PORTAS_DE_TOKEN o Bearer nem chega à rota. A porta precisa ser
 * ESTREITA: id em forma de UUID, âncora nos dois lados.
 *
 * Irmãos literais (ls app/api/v1/leads/[id]/): attachments, clone,
 * contatos-relacionados, eventos, field-proposals, lose, move, next-action,
 * reactivation, retomar, timeline, win — todos ganharam porta. conversion/retry
 * é um irmão literal de [id]/* que NÃO ganhou porta. Os irmãos literais de
 * leads/ (bulk, import, proposals, reactivations) também ganharam porta.
 * lead-captures ficou só de sessão (at-risk ganhou porta na R2: `operacao-r2.test.ts`).
 */
describe("PUBLIC_PATHS — as portas de leads e lead-captures", () => {
  const UUID = "00000000-0000-4000-8000-000000000000";

  it.each([
    "/api/v1/leads",
    `/api/v1/leads/${UUID}`,
    `/api/v1/leads/${UUID}/attachments`,
    `/api/v1/leads/${UUID}/attachments/${UUID}/media`,
    `/api/v1/leads/${UUID}/clone`,
    `/api/v1/leads/${UUID}/contatos-relacionados`,
    `/api/v1/leads/${UUID}/eventos`,
    `/api/v1/leads/${UUID}/field-proposals`,
    `/api/v1/leads/${UUID}/field-proposals/${UUID}`,
    `/api/v1/leads/${UUID}/lose`,
    `/api/v1/leads/${UUID}/move`,
    `/api/v1/leads/${UUID}/next-action`,
    `/api/v1/leads/${UUID}/reactivation`,
    `/api/v1/leads/${UUID}/retomar`,
    `/api/v1/leads/${UUID}/timeline`,
    `/api/v1/leads/${UUID}/win`,
    "/api/v1/leads/bulk",
    "/api/v1/leads/import",
    "/api/v1/leads/proposals",
    "/api/v1/leads/reactivations",
    "/api/v1/leads/at-risk",
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // id fora da forma de UUID
    "/api/v1/leads/abc",
    "/api/v1/leads/x",
    `/api/v1/leads/${UUID}/abc`,
    // sub-path
    `/api/v1/leads/${UUID}/x`,
    // irmão literal de [id]/* que NÃO ganhou porta
    `/api/v1/leads/${UUID}/conversion/retry`,
    // at-risk ganhou porta só no caminho exato; irmãos literais que seguem só de sessão
    "/api/v1/leads/at-risk/x",
    "/api/v1/lead-captures",
    "/api/v1/lead-captures/x",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});

