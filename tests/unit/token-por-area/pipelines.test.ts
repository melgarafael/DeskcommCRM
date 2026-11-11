// @vitest-environment node
/**
 * Token de integração nas rotas de funis (`pipelines`) — Spec 33, fatia R1.
 *
 * Guiado por tabela (`CASOS`): um caso por método convertido, com seis testes
 * cada — token de A alcança, token de B não alcança, sem escopo, abaixo do
 * papel, acima do teto e sessão com o mesmo portão. Previsão, criar etapa,
 * editar e arquivar etapa foram convertidas no lote 3 e têm a bateria própria em
 * `config-r1-lote3.test.ts`.
 *
 * O banco é `criarClienteAdminFalso`: guarda as linhas das duas organizações e
 * acusa cadeia sem `organization_id` (ou RPC de outra organização). No ramo de
 * token o cliente é o admin; o cliente de sessão e o `requireRole` lançam se o
 * ramo de token os tocar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isPublicPath } from "@/lib/auth/public-paths";
import type { Role } from "@/lib/auth/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/server")>()),
  loadAuthUser: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures — declaradas antes do uso
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const PIPE_A = "11111111-1111-4111-8111-111111111111";
const PIPE_A2 = "12121212-1212-4121-8121-121212121212";
const PIPE_B = "22222222-2222-4222-8222-222222222222";
const STAGE_A1 = "31313131-3131-4313-8313-313131313131";
const STAGE_A_GANHO = "32323232-3232-4323-8323-323232323232";
const STAGE_A_PERDA = "33333333-3333-4333-8333-333333333333";
const STAGE_B1 = "41414141-4141-4414-8414-414141414141";
const LEAD_A = "51515151-5151-4515-8515-515151515151";
const LEAD_A2 = "71717171-7171-4717-8717-717171717171";
const LEAD_B = "61616161-6161-4616-8616-616161616161";
const CONTATO_A = "81818181-8181-4818-8818-818181818181";
const AGENTE_A = "91919191-9191-4919-8919-919191919191";
const VERSAO_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const CONVERSA_A = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

/**
 * Tabelas que estas rotas leem ou gravam SEM a coluna `organization_id`. Nenhuma:
 * toda tabela tocada pelos caminhos abaixo tem a coluna (conferido no
 * `supabase/baseline.sql`, incluindo `ai_agent_versions`, que o quadro lê).
 */
const SEM_ORGANIZACAO: readonly string[] = [];

const ORIGEM = "2026-08-01T10:00:00Z";

function funilRow(
  id: string,
  org: string,
  nome: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    organization_id: org,
    name: nome,
    slug: nome.toLowerCase().replace(/\s+/g, "-"),
    description: null,
    is_default: true,
    is_archived: false,
    is_client_pipeline: false,
    position: 1000,
    settings: {},
    vocabulary: null,
    created_at: ORIGEM,
    updated_at: ORIGEM,
    ...extra,
  };
}

function etapaRow(
  id: string,
  org: string,
  pipeline: string,
  nome: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    organization_id: org,
    pipeline_id: pipeline,
    name: nome,
    slug: nome.toLowerCase(),
    position: 1000,
    is_won: false,
    is_lost: false,
    is_archived: false,
    win_probability: null,
    avisar_na_central: false,
    expected_duration_hours: null,
    agent_stage_hint: null,
    last_change_actor_kind: null,
    last_change_at: null,
    ...extra,
  };
}

function negocioRow(
  id: string,
  org: string,
  pipeline: string,
  stage: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    organization_id: org,
    pipeline_id: pipeline,
    stage_id: stage,
    contact_id: null,
    status: "open",
    position_in_stage: 1000,
    owner_user_id: null,
    owner_agent_id: null,
    owner_kind: null,
    title: "Negócio",
    value_cents: 0,
    currency: "BRL",
    tags: [],
    created_at: ORIGEM,
    updated_at: ORIGEM,
    stage_changed_at: ORIGEM,
    last_activity_at: null,
    closed_at: null,
    expected_close_date: null,
    custom_fields: {},
    ...extra,
  };
}

const PIPE_A_ROW = funilRow(PIPE_A, ORG_A, "Funil A");
const PIPE_A2_ROW = funilRow(PIPE_A2, ORG_A, "Funil A2", { is_default: false, position: 2000 });
const PIPE_B_ROW = funilRow(PIPE_B, ORG_B, "Funil B");
const ETAPA_A1 = etapaRow(STAGE_A1, ORG_A, PIPE_A, "Novo");
const ETAPA_A_GANHO = etapaRow(STAGE_A_GANHO, ORG_A, PIPE_A, "Ganho", { is_won: true, position: 2000 });
const ETAPA_A_PERDA = etapaRow(STAGE_A_PERDA, ORG_A, PIPE_A, "Perda", { is_lost: true, position: 3000 });
const ETAPA_B1 = etapaRow(STAGE_B1, ORG_B, PIPE_B, "Novo B");

// Cadeia do quadro de A: negócio com contato, agente dono (com versão publicada),
// conversa do contato e duas propostas de dono (dois negócios abertos do mesmo
// contato, sem desempate: a proposta do agente é ambígua e iria para a caixa).
const CONTATO_A_ROW = {
  id: CONTATO_A,
  organization_id: ORG_A,
  tags: ["cliente-a"],
  phone_number: "5511900000001",
  email: null,
  custom_fields: {},
  is_anonymized: false,
  is_personal: false,
  created_at: ORIGEM,
};
const AGENTE_A_ROW = {
  id: AGENTE_A,
  organization_id: ORG_A,
  name: "Agente Triagem A",
  published_version_id: VERSAO_A,
  created_at: ORIGEM,
};
const VERSAO_A_ROW = { id: VERSAO_A, organization_id: ORG_A, version_number: 3, created_at: ORIGEM };
const CONVERSA_A_ROW = {
  id: CONVERSA_A,
  organization_id: ORG_A,
  contact_id: CONTATO_A,
  last_message_preview: "Oi, quero saber o preço",
  last_message_at: ORIGEM,
  unread_count_for_assignee: 2,
  tags: ["urgente"],
  created_at: ORIGEM,
};
const ESTADO_DO_CONTATO_A = {
  contact_id: CONTATO_A,
  organization_id: ORG_A,
  next_action: "Enviar proposta",
  next_action_seq: 1,
  updated_at: ORIGEM,
};
const LEAD_A_ROW = negocioRow(LEAD_A, ORG_A, PIPE_A, STAGE_A1, {
  contact_id: CONTATO_A,
  owner_kind: "ai",
  owner_agent_id: AGENTE_A,
});
const LEAD_A2_ROW = negocioRow(LEAD_A2, ORG_A, PIPE_A, STAGE_A1, { contact_id: CONTATO_A });
const LEAD_B_ROW = negocioRow(LEAD_B, ORG_B, PIPE_B, STAGE_B1);

const MAPA_VALIDO = {
  new: STAGE_A1,
  contacted: null,
  qualifying: null,
  qualified: null,
  negotiating: null,
  won: STAGE_A_GANHO,
  lost: STAGE_A_PERDA,
};

// ---------------------------------------------------------------------------
// Tabela dos casos
// ---------------------------------------------------------------------------

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

type Caso = {
  nome: string;
  modulo: () => Promise<unknown>;
  metodo: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  caminho: string;
  params: Record<string, string>;
  corpo?: unknown;
  /** O que a sessão tem que ser (o `requireRole` ou o `getUser` da rota). */
  papel: Role;
  escopo: "config:read" | "config:write";
  sucessoStatus: number;
  /** Escrita: o audit sai com `actorUserId: null` e `actorApiTokenId: TOKEN_A`. */
  escrita: boolean;
  /**
   * O que o token de B recebe pelo id de A: 404 (recurso não existe para B),
   * `lista` (200 sem nenhum id de A) ou `criado` (201, linha nova só de B).
   */
  bDe: "404" | "lista" | "criado";
  /** Ids da organização A que não podem aparecer na resposta de B. */
  idsDeA: string[];
  /** Portão da sessão: `requireRole` (padrão) ou `getUser` (quadro). */
  portao?: "requireRole" | "getUser";
  linhas: Record<string, Record<string, unknown>[]>;
};

const CASOS: Caso[] = [
  {
    nome: "GET /api/v1/pipelines",
    modulo: () => import("@/app/api/v1/pipelines/route"),
    metodo: "GET",
    caminho: "/api/v1/pipelines",
    params: {},
    papel: "manager",
    escopo: "config:read",
    sucessoStatus: 200,
    escrita: false,
    bDe: "lista",
    idsDeA: [PIPE_A],
    linhas: { crm_pipelines: [PIPE_A_ROW, PIPE_B_ROW] },
  },
  {
    nome: "POST /api/v1/pipelines",
    modulo: () => import("@/app/api/v1/pipelines/route"),
    metodo: "POST",
    caminho: "/api/v1/pipelines",
    params: {},
    corpo: { name: "Funil novo" },
    papel: "manager",
    escopo: "config:write",
    sucessoStatus: 201,
    escrita: true,
    bDe: "criado",
    idsDeA: [PIPE_A],
    linhas: { crm_pipelines: [PIPE_A_ROW] },
  },
  {
    nome: "GET /api/v1/pipelines/default",
    modulo: () => import("@/app/api/v1/pipelines/default/route"),
    metodo: "GET",
    caminho: "/api/v1/pipelines/default",
    params: {},
    papel: "agent",
    escopo: "config:read",
    sucessoStatus: 200,
    escrita: false,
    bDe: "lista",
    idsDeA: [PIPE_A, STAGE_A1],
    linhas: { crm_pipelines: [PIPE_A_ROW, PIPE_B_ROW], crm_stages: [ETAPA_A1, ETAPA_B1] },
  },
  {
    nome: "PATCH /api/v1/pipelines/[id]",
    modulo: () => import("@/app/api/v1/pipelines/[id]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/pipelines/${PIPE_A}`,
    params: { id: PIPE_A },
    corpo: { name: "Renomeado" },
    papel: "manager",
    escopo: "config:write",
    sucessoStatus: 200,
    escrita: true,
    bDe: "404",
    idsDeA: [PIPE_A],
    linhas: { crm_pipelines: [PIPE_A_ROW, PIPE_B_ROW] },
  },
  {
    nome: "DELETE /api/v1/pipelines/[id]",
    modulo: () => import("@/app/api/v1/pipelines/[id]/route"),
    metodo: "DELETE",
    caminho: `/api/v1/pipelines/${PIPE_A2}`,
    params: { id: PIPE_A2 },
    papel: "manager",
    escopo: "config:write",
    sucessoStatus: 200,
    escrita: true,
    bDe: "404",
    idsDeA: [PIPE_A2],
    linhas: { crm_pipelines: [PIPE_A_ROW, PIPE_A2_ROW, PIPE_B_ROW] },
  },
  {
    nome: "GET /api/v1/pipelines/[id]/agent-mapping",
    modulo: () => import("@/app/api/v1/pipelines/[id]/agent-mapping/route"),
    metodo: "GET",
    caminho: `/api/v1/pipelines/${PIPE_A}/agent-mapping`,
    params: { id: PIPE_A },
    papel: "manager",
    escopo: "config:read",
    sucessoStatus: 200,
    escrita: false,
    bDe: "404",
    idsDeA: [PIPE_A, STAGE_A1],
    linhas: {
      crm_pipelines: [PIPE_A_ROW, PIPE_B_ROW],
      crm_stages: [ETAPA_A1, ETAPA_A_GANHO, ETAPA_A_PERDA, ETAPA_B1],
    },
  },
  {
    nome: "PUT /api/v1/pipelines/[id]/agent-mapping",
    modulo: () => import("@/app/api/v1/pipelines/[id]/agent-mapping/route"),
    metodo: "PUT",
    caminho: `/api/v1/pipelines/${PIPE_A}/agent-mapping`,
    params: { id: PIPE_A },
    corpo: { mapeamento: MAPA_VALIDO },
    papel: "manager",
    escopo: "config:write",
    sucessoStatus: 200,
    escrita: true,
    bDe: "404",
    idsDeA: [PIPE_A, STAGE_A1],
    linhas: {
      crm_pipelines: [PIPE_A_ROW, PIPE_B_ROW],
      crm_stages: [ETAPA_A1, ETAPA_A_GANHO, ETAPA_A_PERDA, ETAPA_B1],
    },
  },
  {
    nome: "GET /api/v1/pipelines/[id]/board",
    modulo: () => import("@/app/api/v1/pipelines/[id]/board/route"),
    metodo: "GET",
    caminho: `/api/v1/pipelines/${PIPE_A}/board`,
    params: { id: PIPE_A },
    papel: "viewer",
    escopo: "config:read",
    sucessoStatus: 200,
    escrita: false,
    bDe: "404",
    idsDeA: [PIPE_A, LEAD_A, LEAD_A2, CONTATO_A, AGENTE_A, CONVERSA_A],
    portao: "getUser",
    linhas: {
      crm_pipelines: [PIPE_A_ROW, PIPE_B_ROW],
      crm_stages: [ETAPA_A1, ETAPA_B1],
      crm_leads: [LEAD_A_ROW, LEAD_A2_ROW, LEAD_B_ROW],
      contacts: [CONTATO_A_ROW],
      ai_agents: [AGENTE_A_ROW],
      ai_agent_versions: [VERSAO_A_ROW],
      conversations: [CONVERSA_A_ROW],
      lead_state: [ESTADO_DO_CONTATO_A],
    },
  },
  {
    nome: "GET /api/v1/pipelines/[id]/leads",
    modulo: () => import("@/app/api/v1/pipelines/[id]/leads/route"),
    metodo: "GET",
    caminho: `/api/v1/pipelines/${PIPE_A}/leads`,
    params: { id: PIPE_A },
    papel: "viewer",
    escopo: "config:read",
    sucessoStatus: 200,
    escrita: false,
    bDe: "404",
    idsDeA: [PIPE_A, LEAD_A],
    linhas: {
      crm_pipelines: [PIPE_A_ROW, PIPE_B_ROW],
      crm_leads: [negocioRow(LEAD_A, ORG_A, PIPE_A, STAGE_A1), negocioRow(LEAD_B, ORG_B, PIPE_B, STAGE_B1)],
    },
  },
  {
    nome: "GET /api/v1/pipelines/[id]/stages",
    modulo: () => import("@/app/api/v1/pipelines/[id]/stages/route"),
    metodo: "GET",
    caminho: `/api/v1/pipelines/${PIPE_A}/stages`,
    params: { id: PIPE_A },
    papel: "manager",
    escopo: "config:read",
    sucessoStatus: 200,
    escrita: false,
    bDe: "lista",
    idsDeA: [STAGE_A1],
    linhas: { crm_stages: [ETAPA_A1, ETAPA_B1] },
  },
  {
    nome: "GET /api/v1/pipelines/[id]/stages/win-rates",
    modulo: () => import("@/app/api/v1/pipelines/[id]/stages/win-rates/route"),
    metodo: "GET",
    caminho: `/api/v1/pipelines/${PIPE_A}/stages/win-rates`,
    params: { id: PIPE_A },
    papel: "manager",
    escopo: "config:read",
    sucessoStatus: 200,
    escrita: false,
    bDe: "lista",
    idsDeA: [STAGE_A1],
    linhas: { crm_stages: [ETAPA_A1, ETAPA_A_GANHO, ETAPA_B1], crm_lead_activities: [], crm_leads: [] },
  },
];

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

let falso: ReturnType<typeof criarClienteAdminFalso>;

function preparar(linhas: Record<string, Record<string, unknown>[]>): void {
  falso = criarClienteAdminFalso({ orgDona: ORG_A, linhas, tabelasSemOrganizacao: SEM_ORGANIZACAO });
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
}

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function requisicao(caso: Caso, token: string | undefined): NextRequest {
  const cabecalhos: Record<string, string> = {};
  if (token) cabecalhos.authorization = `Bearer ${token}`;
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {
    method: caso.metodo,
    headers: cabecalhos,
  };
  if (caso.corpo !== undefined) {
    cabecalhos["content-type"] = "application/json";
    init.body = JSON.stringify(caso.corpo);
  }
  return new NextRequest(`http://localhost${caso.caminho}`, init);
}

async function chamar(caso: Caso, token: string | undefined): Promise<Response> {
  const mod = (await caso.modulo()) as unknown as Record<string, Handler | undefined>;
  const handler = mod[caso.metodo];
  if (!handler) throw new Error(`${caso.metodo} não exportado por ${caso.nome}`);
  return handler(requisicao(caso, token), { params: Promise.resolve(caso.params) });
}

/**
 * As linhas de uma organização, copiadas, para comparar antes e depois.
 * Tabela sem nenhuma linha da organização não entra: o cliente falso cria a
 * chave vazia quando a rota só CONSULTA a tabela, e isso não é escrita. Quem
 * escreveu linha de outra organização na lista de A continua vermelho.
 */
function fotografia(linhas: Record<string, Record<string, unknown>[]>, org: string): unknown {
  const filtradas = Object.fromEntries(
    Object.entries(linhas)
      .map(([tabela, lista]) => [tabela, lista.filter((l) => l.organization_id === org)] as const)
      .filter(([, lista]) => lista.length > 0),
  );
  return JSON.parse(JSON.stringify(filtradas)) as unknown;
}

beforeEach(() => {
  vi.resetAllMocks();
  preparar({});
  // Tripwires: se o ramo de token tocar a sessão, a chamada quebra.
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30 } as never);
});

// ===========================================================================
// Métodos convertidos: seis testes por caso
// ===========================================================================
describe.each(CASOS)("$nome — token por área", (caso) => {
  it("token de A alcança o recurso de A (2xx, sem cadeia fora de A)", async () => {
    preparar(caso.linhas);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await chamar(caso, TOKEN_A);
    expect(res.status).toBe(caso.sucessoStatus);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    if (caso.escrita) {
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: null,
          actorApiTokenId: TOKEN_A,
          organizationId: ORG_A,
        }),
      );
    }
  });

  it("token de B não alcança o recurso de A (404, lista só de B ou linha nova de B)", async () => {
    preparar(caso.linhas);
    tokenDe(ORG_B, TOKEN_B, "admin");
    const antes = fotografia(falso.linhas, ORG_A);
    const res = await chamar(caso, TOKEN_B);
    const texto = await res.clone().text();
    if (caso.bDe === "404") expect(res.status).toBe(404);
    else if (caso.bDe === "lista") expect(res.status).toBe(200);
    else expect(res.status).toBe(201);
    for (const id of caso.idsDeA) expect(texto).not.toContain(id);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(fotografia(falso.linhas, ORG_A)).toEqual(antes);
    if (caso.bDe === "404") {
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it("token sem o escopo do método é recusado (403), sem escrita", async () => {
    preparar(caso.linhas);
    const outro = caso.escopo === "config:read" ? "config:write" : "config:read";
    tokenDe(ORG_A, TOKEN_A, "admin", [outro]);
    const res = await chamar(caso, TOKEN_A);
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (tokenRole admin) é recusado (403)", async () => {
    preparar(caso.linhas);
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await chamar(caso, TOKEN_A);
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem tocar no banco", async () => {
    preparar(caso.linhas);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await chamar(caso, TOKEN_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  if (caso.portao === "getUser") {
    it("sessão continua com o mesmo portão (getUser sem usuário → 401, sem token)", async () => {
      vi.mocked(createClient).mockResolvedValueOnce({
        auth: { getUser: async () => ({ data: { user: null }, error: null }) },
      } as never);
      const res = await chamar(caso, undefined);
      expect(res.status).toBe(401);
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(requireRole).not.toHaveBeenCalled();
    });
  } else {
    it("sessão continua com o mesmo portão (requireRole com o papel da tabela)", async () => {
      vi.mocked(requireRole).mockResolvedValueOnce({
        ok: false,
        response: new Response(null, { status: 403 }),
      } as never);
      const res = await chamar(caso, undefined);
      expect(res.status).toBe(403);
      expect(requireRole).toHaveBeenCalledWith(caso.papel, expect.objectContaining({ resource: expect.any(String) }));
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(falso.cadeias).toEqual([]);
    });
  }
});

// ===========================================================================
// Borda do proxy: cada porta nova libera o caminho com UUID e nada além dele
// ===========================================================================
describe("PUBLIC_PATHS — borda das portas de pipelines", () => {
  const COM_ID = [
    "/api/v1/pipelines/[id]",
    "/api/v1/pipelines/[id]/agent-mapping",
    "/api/v1/pipelines/[id]/board",
    "/api/v1/pipelines/[id]/leads",
    "/api/v1/pipelines/[id]/stages",
    "/api/v1/pipelines/[id]/stages/win-rates",
  ];
  const LITERAIS = ["/api/v1/pipelines", "/api/v1/pipelines/default"];

  it("libera os caminhos com id em forma de UUID e os literais", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", PIPE_A))).toBe(true);
    for (const c of LITERAIS) expect(isPublicPath(c)).toBe(true);
  });

  it("não libera id fora da forma de UUID", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", "abc"))).toBe(false);
  });

  it("não libera sub-path /x em nenhum caminho da lista", () => {
    for (const c of [...COM_ID, ...LITERAIS]) expect(isPublicPath(`${c}/x`)).toBe(false);
  });

  it("irmãos fora da forma seguem fora (barra final, id da etapa fora da forma de UUID)", () => {
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/stages/`)).toBe(false);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/stages/abc`)).toBe(false);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/stages/${STAGE_A1}/x`)).toBe(false);
  });

  it("forecast e stages/[stageId] ganharam porta no lote 3 (a bateria própria está em config-r1-lote3.test.ts)", () => {
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/forecast`)).toBe(true);
    expect(isPublicPath(`/api/v1/pipelines/${PIPE_A}/stages/${STAGE_A1}`)).toBe(true);
  });

  it("o literal default não entra por [id]: é só o próprio caminho", () => {
    expect(isPublicPath("/api/v1/pipelines/abc")).toBe(false);
  });
});

// ===========================================================================
// Quadro com token: os auxiliares leem só a organização do token, e a leitura
// não escreve. O controle pela sessão prova que a MESMA cadeia de dados gera o
// aviso que o token não pode gerar: sem ele, "sem escrita" poderia ser vazio
// por falta de fixture.
// ===========================================================================
describe("GET board — token lê só a própria organização, sem escrever", () => {
  const CASO_QUADRO = CASOS.find((c) => c.nome === "GET /api/v1/pipelines/[id]/board")!;
  const TABELAS_DOS_AUXILIARES = [
    "contacts",
    "conversations",
    "ai_agents",
    "ai_agent_versions",
    "lead_state",
    "crm_lead_scores",
    "crm_tasks",
  ];

  function quadroDe(pipelineId: string): Caso {
    return { ...CASO_QUADRO, caminho: `/api/v1/pipelines/${pipelineId}/board`, params: { id: pipelineId } };
  }

  it("token de A: 200 com os dados de A, consultas só com organization_id de A, nenhuma escrita", async () => {
    const caso = quadroDe(PIPE_A);
    preparar(caso.linhas);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await chamar(caso, TOKEN_A);
    expect(res.status).toBe(200);
    const texto = await res.clone().text();
    expect(texto).toContain(LEAD_A);
    expect(texto).toContain(CONVERSA_A);
    expect(texto).toContain("Agente Triagem A");
    const tabelas = falso.cadeias.map((c) => c.tabela);
    expect(tabelas).toEqual(expect.arrayContaining(TABELAS_DOS_AUXILIARES));
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias).map((c) => c.tabela)).not.toContain("agent_inbox_items");
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token de B no próprio funil (PIPE_B): 200 só com B, nenhum id de A, consultas só de B", async () => {
    const caso = quadroDe(PIPE_B);
    preparar(caso.linhas);
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await chamar(caso, TOKEN_B);
    expect(res.status).toBe(200);
    const texto = await res.clone().text();
    expect(texto).toContain(LEAD_B);
    for (const id of [PIPE_A, LEAD_A, LEAD_A2, CONTATO_A, AGENTE_A, CONVERSA_A]) {
      expect(texto).not.toContain(id);
    }
    expect(texto).not.toContain("Agente Triagem A");
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("controle pela SESSÃO com a mesma ambiguidade: o aviso é gravado (o 'sem escrita' do token não é vazio por acaso)", async () => {
    const caso = quadroDe(PIPE_A);
    preparar(caso.linhas);
    const cliente = falso.cliente as unknown as {
      from: (tabela: string) => { eq: (coluna: string, valor: unknown) => unknown };
    };
    // Cliente de SESSÃO: o RLS da sessão deixa ver só a organização do usuário
    // (usuario-a é de ORG_A). O dublê não simula RLS, então o filtro entra aqui,
    // no lugar do RLS: a consulta do funil por `id` sem `organization_id` (a rota
    // confia no RLS na sessão) acharia zero linhas e daria 404.
    vi.mocked(createClient).mockResolvedValueOnce({
      from: (tabela: string) => cliente.from(tabela).eq("organization_id", ORG_A),
      auth: { getUser: async () => ({ data: { user: { id: "usuario-a" } }, error: null }) },
    } as never);
    vi.mocked(loadAuthUser).mockResolvedValueOnce(null);
    const res = await chamar(caso, undefined);
    expect(res.status).toBe(200);
    expect(cadeiasDeEscrita(falso.cadeias).map((c) => c.tabela)).toEqual(["agent_inbox_items"]);
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PUT agent-mapping com token de B no PRÓPRIO funil, mas com etapas de A no corpo
// ===========================================================================
describe("PUT agent-mapping — token de B no próprio funil com etapas de A", () => {
  it("recusa por validação (422), sem escrita e com o funil de A intacto", async () => {
    const base = CASOS.find((c) => c.nome === "PUT /api/v1/pipelines/[id]/agent-mapping")!;
    const caso: Caso = { ...base, caminho: `/api/v1/pipelines/${PIPE_B}/agent-mapping`, params: { id: PIPE_B } };
    preparar(caso.linhas);
    tokenDe(ORG_B, TOKEN_B, "admin");
    const antes = fotografia(falso.linhas, ORG_A);
    const res = await chamar(caso, TOKEN_B);
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(fotografia(falso.linhas, ORG_A)).toEqual(antes);
  });
});
