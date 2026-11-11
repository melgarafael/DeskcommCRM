// @vitest-environment node
/**
 * EMPRESAS, PESSOAS, VÍNCULOS E NÚMEROS DE VOZ ACEITAM TOKEN (Spec 33, fatia R2,
 * tarefa 7).
 *
 * Rotas: companies (GET/POST), companies/[id] (GET/PATCH/DELETE),
 * companies/lookup (GET), companies/[id]/enrich (POST), company-people (POST),
 * company-people/[id] (PATCH), people (GET/POST), people/[id] (GET/PATCH),
 * phone-numbers (GET/POST), phone-numbers/[id] (PATCH). Os 16 métodos convertidos.
 *
 * No ramo do token o cliente é a service role: a RLS não protege, e o que separa
 * a organização A da B é o `eq("organization_id", …)` de cada consulta e de cada
 * escrita. O cliente falso (`../helpers/cliente-admin-falso`) vê exatamente isso.
 *
 * Sete testes por caso: os seis da receita (token de A alcança; token de B não
 * alcança; sem o escopo; abaixo do papel; acima do teto do token; sessão com o
 * mesmo portão) e o teto por ORGANIZAÇÃO. Depois, o que só o ramo do token
 * precisa garantir (embed substituído por consulta própria, autor null, agente de
 * outra organização recusado) e a borda das portas em `PUBLIC_PATHS`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createBrasilApiClient } from "@/lib/brasil-api/client";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
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
// A BrasilAPI é a única rede desta área: o cliente é dublado, o mapeamento é real.
vi.mock("@/lib/brasil-api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/brasil-api/client")>();
  return { ...actual, createBrasilApiClient: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

// O número de telefone só é criado se o troncal estiver configurado.
process.env.VOIP_TRUNK_ENDPOINT = "sip.teste.local";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const PESSOA_DA_SESSAO = "c1000000-0000-4000-8000-000000000001";
const CNPJ = "33547054000120";

const EMPRESA_A = "e1000000-0000-4000-8000-00000000000a";
const EMPRESA_B = "e1000000-0000-4000-8000-00000000000b";
const EMPRESA_A_LIVRE = "e1000000-0000-4000-8000-0000000000aa";
const EMPRESA_B_LIVRE = "e1000000-0000-4000-8000-0000000000bb";
const PESSOA_A = "f1000000-0000-4000-8000-00000000000a";
const PESSOA_A2 = "f1000000-0000-4000-8000-00000000000c";
const PESSOA_B = "f1000000-0000-4000-8000-00000000000b";
const VINCULO_A = "d1000000-0000-4000-8000-00000000000a";
const VINCULO_B = "d1000000-0000-4000-8000-00000000000b";
const CONTATO_A = "c2000000-0000-4000-8000-00000000000a";
const CONTATO_B = "c2000000-0000-4000-8000-00000000000b";
const AGENTE_A = "a3000000-0000-4000-8000-00000000000a";
const AGENTE_B = "a3000000-0000-4000-8000-00000000000b";
const NUMERO_A = "b4000000-0000-4000-8000-00000000000a";
const NUMERO_B = "b4000000-0000-4000-8000-00000000000b";

/**
 * Tabelas GLOBAIS da instalação, sem `organization_id` no baseline: a flag de
 * módulo (`platform_config`) e a tabela de módulos instalados. Ler delas sem filtro
 * de organização é correto, e o dublê precisa saber disso.
 */
const SEM_ORGANIZACAO: readonly string[] = ["platform_config", "modulos_instalados"];

type Linha = Record<string, unknown>;
type Linhas = Record<string, Linha[]>;
type Metodo = "GET" | "POST" | "PATCH" | "DELETE";
type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "mcp:read" | "mcp:write";
type Carregador = () => Promise<unknown>;

const ANTES = "2026-11-01T10:00:00.000Z";

/**
 * Linhas da organização A que as rotas precisam para responder 2xx, mais uma linha
 * da B na mesma tabela, para o caso "token de A" provar que a de B não aparece.
 * Colunas conferidas em supabase/baseline.sql e nos SELECTs dos handlers.
 */
const LINHAS: Linhas = {
  platform_config: [{ chave: "MODULO_CRM_B2B", valor: "ligado" }],
  companies: [
    {
      id: EMPRESA_A,
      organization_id: ORG_A,
      legal_name: "Empresa da A Ltda",
      trade_name: "Empresa da A",
      cnpj: "33.547.054/0001-20",
      normalized_cnpj: CNPJ,
      enrichment_status: "pending",
      created_by: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
    {
      id: EMPRESA_A_LIVRE,
      organization_id: ORG_A,
      legal_name: null,
      trade_name: "Empresa livre da A",
      cnpj: null,
      normalized_cnpj: null,
      enrichment_status: "pending",
      created_by: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
    {
      id: EMPRESA_B,
      organization_id: ORG_B,
      legal_name: "Empresa da B Ltda",
      trade_name: "Empresa da B",
      cnpj: null,
      normalized_cnpj: null,
      enrichment_status: "pending",
      created_by: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
    {
      id: EMPRESA_B_LIVRE,
      organization_id: ORG_B,
      legal_name: null,
      trade_name: "Empresa livre da B",
      cnpj: null,
      normalized_cnpj: null,
      enrichment_status: "pending",
      created_by: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
  ],
  people: [
    {
      id: PESSOA_A,
      organization_id: ORG_A,
      full_name: "Pessoa da A",
      normalized_name: "pessoa da a",
      email: null,
      notes: null,
      created_by: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
    {
      id: PESSOA_A2,
      organization_id: ORG_A,
      full_name: "Pessoa da A2",
      normalized_name: "pessoa da a2",
      email: null,
      notes: null,
      created_by: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
    {
      id: PESSOA_B,
      organization_id: ORG_B,
      full_name: "Pessoa da B",
      normalized_name: "pessoa da b",
      email: null,
      notes: null,
      created_by: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
  ],
  company_people: [
    {
      id: VINCULO_A,
      organization_id: ORG_A,
      company_id: EMPRESA_A,
      person_id: PESSOA_A,
      job_title: "Diretora",
      department: null,
      is_decision_maker: true,
      is_primary: true,
      notes: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
    {
      id: VINCULO_B,
      organization_id: ORG_B,
      company_id: EMPRESA_B,
      person_id: PESSOA_B,
      job_title: "Diretor",
      department: null,
      is_decision_maker: true,
      is_primary: true,
      notes: null,
      created_at: ANTES,
      updated_at: ANTES,
    },
  ],
  contacts: [
    {
      id: CONTATO_A,
      organization_id: ORG_A,
      person_id: PESSOA_A,
      phone_number: "5562911110000",
      display_name: "Contato da A",
      name: null,
      email: null,
      is_blocked: false,
      is_merged_into: null,
    },
    {
      id: CONTATO_B,
      organization_id: ORG_B,
      person_id: PESSOA_B,
      phone_number: "5562922220000",
      display_name: "Contato da B",
      name: null,
      email: null,
      is_blocked: false,
      is_merged_into: null,
    },
  ],
  ai_agents: [
    { id: AGENTE_A, organization_id: ORG_A, name: "Atendente da A" },
    { id: AGENTE_B, organization_id: ORG_B, name: "Atendente da B" },
  ],
  phone_numbers: [
    {
      id: NUMERO_A,
      organization_id: ORG_A,
      number: "+5562911110000",
      label: "Principal A",
      routing_mode: "ai",
      default_ai_agent_id: AGENTE_A,
      is_active: true,
      created_at: ANTES,
    },
    {
      id: NUMERO_B,
      organization_id: ORG_B,
      number: "+5562922220000",
      label: "Principal B",
      routing_mode: "ai",
      default_ai_agent_id: AGENTE_B,
      is_active: true,
      created_at: ANTES,
    },
  ],
};

/** Textos e ids que só existem na organização A (e na B, espelhado). */
const SO_DA_A = [
  ORG_A,
  EMPRESA_A,
  EMPRESA_A_LIVRE,
  PESSOA_A,
  PESSOA_A2,
  VINCULO_A,
  CONTATO_A,
  AGENTE_A,
  NUMERO_A,
  "Empresa da A",
  "Empresa livre da A",
  "Pessoa da A",
  "Atendente da A",
  "+5562911110000",
];
const SO_DA_B = [
  ORG_B,
  EMPRESA_B,
  EMPRESA_B_LIVRE,
  PESSOA_B,
  VINCULO_B,
  CONTATO_B,
  AGENTE_B,
  NUMERO_B,
  "Empresa da B",
  "Empresa livre da B",
  "Pessoa da B",
  "Atendente da B",
  "+5562922220000",
];

type Caso = {
  carrega: Carregador;
  metodo: Metodo;
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
  linhas: Linhas;
  /** Papel da sessão (`requireRole`) e o da tabela do plano. */
  papel: Papel;
  escopo: Escopo;
  /** `resource` que a rota passa ao portão de sessão. */
  recurso: string;
  /** Recurso do teto de escrita por token (`tetoDeEscritaDoToken`). */
  teto: string;
  /** Status 2xx que o token de A e a sessão recebem. */
  status: number;
  /** Status que o token de B recebe quando o recurso é de A (padrão 404). */
  statusParaB?: number;
  /** Lista: o token de A vê só `daA`; o de B vê só `daB`. */
  colecao?: { daA: string; daB: string };
  audita?: boolean;
  /** Criação: o token de B cria a própria linha, na organização B. */
  cria?: boolean;
  /** Tabela que a criação grava (conferência do teste "token de B"). */
  tabela?: string;
};

const CASOS: readonly Caso[] = [
  {
    carrega: () => import("@/app/api/v1/companies/route"),
    metodo: "GET",
    caminho: "/api/v1/companies",
    linhas: LINHAS,
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "companies",
    teto: "companies_list",
    status: 200,
    colecao: { daA: "Empresa da A", daB: "Empresa da B" },
  },
  {
    carrega: () => import("@/app/api/v1/companies/route"),
    metodo: "POST",
    caminho: "/api/v1/companies",
    corpo: { legal_name: "Empresa nova Ltda", trade_name: "Empresa nova", enrich: false },
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "companies",
    teto: "companies_create",
    status: 201,
    audita: true,
    cria: true,
    tabela: "companies",
  },
  {
    carrega: () => import("@/app/api/v1/companies/[id]/route"),
    metodo: "GET",
    caminho: `/api/v1/companies/${EMPRESA_A}`,
    params: { id: EMPRESA_A },
    linhas: LINHAS,
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "companies",
    teto: "companies_read",
    status: 200,
  },
  {
    carrega: () => import("@/app/api/v1/companies/[id]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/companies/${EMPRESA_A}`,
    params: { id: EMPRESA_A },
    corpo: { trade_name: "Empresa da A renomeada" },
    linhas: LINHAS,
    papel: "agent",
    escopo: "mcp:write",
    recurso: "companies",
    teto: "companies_update",
    status: 200,
    audita: true,
  },
  {
    carrega: () => import("@/app/api/v1/companies/[id]/route"),
    metodo: "DELETE",
    caminho: `/api/v1/companies/${EMPRESA_A_LIVRE}`,
    params: { id: EMPRESA_A_LIVRE },
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "companies",
    teto: "companies_delete",
    status: 200,
    audita: true,
  },
  {
    carrega: () => import("@/app/api/v1/companies/lookup/route"),
    metodo: "GET",
    caminho: `/api/v1/companies/lookup?cnpj=${CNPJ}`,
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:read",
    recurso: "companies",
    teto: "companies_lookup",
    status: 200,
    // A consulta é só leitura: o token de B recebe 200, sem o registro de A.
    statusParaB: 200,
  },
  {
    carrega: () => import("@/app/api/v1/companies/[id]/enrich/route"),
    metodo: "POST",
    caminho: `/api/v1/companies/${EMPRESA_A}/enrich`,
    params: { id: EMPRESA_A },
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "companies",
    teto: "companies_enrich",
    status: 200,
    audita: true,
  },
  {
    carrega: () => import("@/app/api/v1/company-people/route"),
    metodo: "POST",
    caminho: "/api/v1/company-people",
    corpo: { company_id: EMPRESA_A, person_id: PESSOA_A2, job_title: "Gerente" },
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "company_people",
    teto: "company_people_link",
    status: 201,
    audita: true,
  },
  {
    carrega: () => import("@/app/api/v1/company-people/[id]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/company-people/${VINCULO_A}`,
    params: { id: VINCULO_A },
    corpo: { job_title: "Diretora Financeira" },
    linhas: LINHAS,
    papel: "agent",
    escopo: "mcp:write",
    recurso: "company_people",
    teto: "company_people_update",
    status: 200,
    audita: true,
  },
  {
    carrega: () => import("@/app/api/v1/people/route"),
    metodo: "GET",
    caminho: "/api/v1/people",
    linhas: LINHAS,
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "people",
    teto: "people_list",
    status: 200,
    colecao: { daA: "Pessoa da A", daB: "Pessoa da B" },
  },
  {
    carrega: () => import("@/app/api/v1/people/route"),
    metodo: "POST",
    caminho: "/api/v1/people",
    corpo: { full_name: "Pessoa nova" },
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "people",
    teto: "people_create",
    status: 201,
    audita: true,
    cria: true,
    tabela: "people",
  },
  {
    carrega: () => import("@/app/api/v1/people/[id]/route"),
    metodo: "GET",
    caminho: `/api/v1/people/${PESSOA_A}`,
    params: { id: PESSOA_A },
    linhas: LINHAS,
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "people",
    teto: "people_read",
    status: 200,
  },
  {
    carrega: () => import("@/app/api/v1/people/[id]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/people/${PESSOA_A}`,
    params: { id: PESSOA_A },
    corpo: { notes: "Atualizada pelo token" },
    linhas: LINHAS,
    papel: "agent",
    escopo: "mcp:write",
    recurso: "people",
    teto: "people_update",
    status: 200,
    audita: true,
  },
  {
    carrega: () => import("@/app/api/v1/phone-numbers/route"),
    metodo: "GET",
    caminho: "/api/v1/phone-numbers",
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:read",
    recurso: "phone_numbers",
    teto: "phone_numbers_list",
    status: 200,
    colecao: { daA: "+5562911110000", daB: "+5562922220000" },
  },
  {
    carrega: () => import("@/app/api/v1/phone-numbers/route"),
    metodo: "POST",
    caminho: "/api/v1/phone-numbers",
    corpo: { number: "+5562933330000", label: "Linha nova", routing_mode: "ai", is_active: true },
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "phone_numbers",
    teto: "phone_numbers_create",
    status: 201,
    audita: true,
    cria: true,
    tabela: "phone_numbers",
  },
  {
    carrega: () => import("@/app/api/v1/phone-numbers/[id]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/phone-numbers/${NUMERO_A}`,
    params: { id: NUMERO_A },
    corpo: { label: "Principal A ajustado" },
    linhas: LINHAS,
    papel: "manager",
    escopo: "mcp:write",
    recurso: "phone_numbers",
    teto: "phone_numbers_update",
    status: 200,
    audita: true,
  },
];

const PN_CRIA = CASOS.find((c) => c.metodo === "POST" && c.caminho === "/api/v1/phone-numbers");
if (!PN_CRIA) throw new Error("caso de criar número ausente");

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
  return `${c.metodo} ${c.caminho}`;
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
  const modulo = (await c.carrega()) as unknown as Record<string, Manipulador | undefined>;
  const manipulador = modulo[c.metodo];
  if (!manipulador) throw new Error(`método ${c.metodo} ausente em ${c.caminho}`);
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
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  tokenValido({
    org,
    id: org === ORG_A ? TOKEN_A : TOKEN_B,
    papel: o.papel ?? c.papel,
    escopos: o.escopos ?? [c.escopo],
  });
  const res = await chamar(c, requisicao(c, AUTORIZACAO));
  const texto = await res.text();
  return { res, texto, falso };
}

/** Chama o método SEM Authorization: o caminho de sessão segue o seu portão. */
async function comoSessao(c: Caso) {
  const falso = criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: c.linhas,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
  vi.mocked(createClient).mockImplementation(async () => falso.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org", role: c.papel },
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

/** Cadeias de tabela que não são a flag de módulo: o que a rota fez de verdade. */
function cadeiasDeDados(falso: { cadeias: { tabela: string }[] }) {
  return falso.cadeias.filter((ch) => !SEM_ORGANIZACAO.includes(ch.tabela));
}

const RESPOSTA_BRASILAPI = {
  ok: true as const,
  data: { razao_social: "EMPRESA DA A LTDA", cnpj: CNPJ },
  raw: { razao_social: "EMPRESA DA A LTDA", qsa: [] },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error("cliente de sessão usado no ramo do token");
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(audit).mockResolvedValue(undefined);
  vi.mocked(createBrasilApiClient).mockReturnValue({
    lookupCnpj: async () => RESPOSTA_BRASILAPI,
  } as never);
});

// ─── Os sete testes de cada método ──────────────────────────────────────────

describe("empresas, pessoas, vínculos e números aceitam token", () => {
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
      const { res, texto, falso } = await comoToken(c, { org: ORG_B });

      if (c.colecao) {
        // Lista: 200 com a lista de B, e nada de A.
        expect(res.status, texto).toBe(200);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        expect(texto).toContain(c.colecao.daB);
        expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      } else if (c.cria) {
        // Criação: o token de B cria a PRÓPRIA linha, na organização B.
        expect(res.status, texto).toBe(c.status);
        for (const deA of SO_DA_A) expect(texto).not.toContain(deA);
        const tabela = c.tabela ?? "";
        const antes = new Set((c.linhas[tabela] ?? []).map((l) => l.id));
        const criadas = linhasDaTabela(falso, tabela).filter((l) => !antes.has(l.id));
        expect(criadas).toHaveLength(1);
        expect(criadas[0]?.organization_id).toBe(ORG_B);
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_B, actorApiTokenId: TOKEN_B }),
        );
        expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
      } else {
        // Recurso de A: não existe para B, e nada é gravado.
        expect(res.status, texto).toBe(c.statusParaB ?? 404);
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
      const outro: Escopo = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      const { res, texto, falso } = await comoToken(c, { escopos: [outro] });

      expect(res.status, texto).toBe(403);
      expect(cadeiasDeDados(falso)).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    if (c.papel !== "viewer") {
      it(`${n}: token abaixo do papel é recusado`, async () => {
        const { res, texto, falso } = await comoToken(c, { papel: DEGRAU_ABAIXO[c.papel] });

        expect(res.status, texto).toBe(403);
        expect(cadeiasDeDados(falso)).toEqual([]);
        expect(falso.rpcs).toEqual([]);
        expect(audit).not.toHaveBeenCalled();
      });
    }

    it(`${n}: acima do teto do token → 429`, async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(cadeiasDeDados(falso)).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
      expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`${c.teto}:tok:${TOKEN_A}`);
    });

    it(`${n}: acima do teto da organização → 429`, async () => {
      vi.mocked(checkRateLimit)
        .mockResolvedValueOnce({ allowed: true } as never)
        .mockResolvedValueOnce({ allowed: false } as never);
      const { res, texto, falso } = await comoToken(c);

      expect(res.status, texto).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(vi.mocked(checkRateLimit).mock.calls[1]?.[0]).toBe(`${c.teto}:org:${ORG_A}`);
      expect(cadeiasDeDados(falso)).toEqual([]);
      expect(falso.rpcs).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${n}: sessão continua com o mesmo portão`, async () => {
      const { res, texto } = await comoSessao(c);

      expect(res.status, texto).toBe(c.status);
      expect(requireRole).toHaveBeenCalledWith(c.papel, expect.objectContaining({ resource: c.recurso }));
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG_A, actorUserId: PESSOA_DA_SESSAO }),
        );
      }
      // A sessão nunca leva id de token: a trilha só ganha `actorApiTokenId` com token.
      for (const [entrada] of vi.mocked(audit).mock.calls) {
        expect((entrada as { actorApiTokenId?: unknown }).actorApiTokenId ?? null).toBeNull();
      }
    });
  }
});

// ─── O que só o ramo do token precisa garantir ──────────────────────────────

describe("o ramo do token em empresas, pessoas e números", () => {
  it("GET /api/v1/companies/[id]: junta a pessoa de cada vínculo, sem embed, só da organização", async () => {
    const c = CASOS.find((x) => x.metodo === "GET" && x.caminho === `/api/v1/companies/${EMPRESA_A}`);
    if (!c) throw new Error("caso ausente");
    const { res, texto } = await comoToken(c);

    expect(res.status, texto).toBe(200);
    const dados = json<{ data: { people: Array<{ people: { full_name: string } | null }> } }>(texto).data;
    expect(dados.people[0]?.people?.full_name).toBe("Pessoa da A");
    expect(texto).not.toContain("Pessoa da B");
  });

  it("GET /api/v1/people/[id]: junta a empresa de cada vínculo, sem embed, só da organização", async () => {
    const c = CASOS.find((x) => x.metodo === "GET" && x.caminho === `/api/v1/people/${PESSOA_A}`);
    if (!c) throw new Error("caso ausente");
    const { res, texto } = await comoToken(c);

    expect(res.status, texto).toBe(200);
    const dados = json<{ data: { companies: Array<{ companies: { trade_name: string } | null }> } }>(texto).data;
    expect(dados.companies[0]?.companies?.trade_name).toBe("Empresa da A");
    expect(texto).not.toContain("Empresa da B");
  });

  it("GET /api/v1/phone-numbers: o nome do agente vem da organização do token", async () => {
    const c = CASOS.find((x) => x.metodo === "GET" && x.caminho === "/api/v1/phone-numbers");
    if (!c) throw new Error("caso ausente");
    const { res, texto } = await comoToken(c);

    expect(res.status, texto).toBe(200);
    const linhas = json<{ data: Array<{ id: string; agent: { name: string } | null }> }>(texto).data;
    expect(linhas.find((l) => l.id === NUMERO_A)?.agent?.name).toBe("Atendente da A");
    expect(texto).not.toContain("Atendente da B");
  });

  it("POST /api/v1/companies: o token não assina como pessoa (created_by null)", async () => {
    const c = CASOS.find((x) => x.metodo === "POST" && x.caminho === "/api/v1/companies");
    if (!c) throw new Error("caso ausente");
    const antes = new Set((c.linhas.companies ?? []).map((l) => l.id));
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(201);
    const criada = linhasDaTabela(falso, "companies").find((l) => !antes.has(l.id));
    expect(criada?.organization_id).toBe(ORG_A);
    expect(criada?.created_by).toBeNull();
  });

  it("POST /api/v1/people: o token não assina como pessoa (created_by null)", async () => {
    const c = CASOS.find((x) => x.metodo === "POST" && x.caminho === "/api/v1/people");
    if (!c) throw new Error("caso ausente");
    const antes = new Set((c.linhas.people ?? []).map((l) => l.id));
    const { res, texto, falso } = await comoToken(c);

    expect(res.status, texto).toBe(201);
    const criada = linhasDaTabela(falso, "people").find((l) => !antes.has(l.id));
    expect(criada?.organization_id).toBe(ORG_A);
    expect(criada?.created_by).toBeNull();
  });

  it("POST /api/v1/phone-numbers: agente de outra organização é recusado sem gravar", async () => {
    const c: Caso = {
      ...PN_CRIA,
      corpo: { number: "+5562944440000", routing_mode: "ai", is_active: true, default_ai_agent_id: AGENTE_A },
    };
    const { res, texto, falso } = await comoToken(c, { org: ORG_B });

    expect(res.status, texto).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("GET /api/v1/companies/lookup: o token de B não vê a empresa de A (already_registered)", async () => {
    const c = CASOS.find((x) => x.metodo === "GET" && x.caminho.startsWith("/api/v1/companies/lookup"));
    if (!c) throw new Error("caso ausente");
    const { res: resB, texto: textoB } = await comoToken(c, { org: ORG_B });
    expect(resB.status, textoB).toBe(200);
    expect(json<{ data: { already_registered: boolean } }>(textoB).data.already_registered).toBe(false);

    const { res: resA, texto: textoA } = await comoToken(c);
    expect(resA.status, textoA).toBe(200);
    expect(json<{ data: { already_registered: boolean } }>(textoA).data.already_registered).toBe(true);
  });
});

// ─── A borda das portas em PUBLIC_PATHS ─────────────────────────────────────

describe("PUBLIC_PATHS — as portas de empresas, pessoas e números", () => {
  it.each([
    "/api/v1/companies",
    "/api/v1/companies/lookup",
    `/api/v1/companies/${EMPRESA_A}`,
    `/api/v1/companies/${EMPRESA_A}/enrich`,
    "/api/v1/company-people",
    `/api/v1/company-people/${VINCULO_A}`,
    "/api/v1/people",
    `/api/v1/people/${PESSOA_A}`,
    "/api/v1/phone-numbers",
    `/api/v1/phone-numbers/${NUMERO_A}`,
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    "/api/v1/companies/abc",
    `/api/v1/companies/${EMPRESA_A}/x`,
    `/api/v1/companies/${EMPRESA_A}/enrich/x`,
    "/api/v1/companies/lookup/x",
    "/api/v1/company-people/abc",
    `/api/v1/company-people/${VINCULO_A}/x`,
    `/api/v1/people/${PESSOA_A}/x`,
    "/api/v1/people/abc",
    "/api/v1/phone-numbers/abc",
    `/api/v1/phone-numbers/${NUMERO_A}/x`,
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
