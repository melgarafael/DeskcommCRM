// @vitest-environment node
/**
 * Token de integração nas rotas de campanhas (Spec 33, fatia R2, tarefa 6).
 *
 * Rotas convertidas (10 arquivos, 15 métodos), por método:
 *  - token de A alcança o recurso de A (2xx, e nada de B lido ou escrito);
 *  - token de B não alcança o recurso de A (404, 409 ou lista só de B);
 *  - token sem o escopo DESTE método é recusado (403);
 *  - token abaixo do papel (manager) é recusado (403);
 *  - acima do teto do token → 429 com Retry-After, sem tocar no banco;
 *  - sessão continua com o mesmo portão (`requireRole` com `manager`).
 *
 * FICA DE FORA (só sessão): `campaigns/[id]/[acao]` POST. Inicia, retoma e
 * testa envio a cliente final: o teste "fica só de sessão" prova o 401 e que o
 * cliente admin nunca foi aberto.
 *
 * O banco é `criarClienteAdminFalso`: guarda as linhas das duas organizações e
 * acusa cadeia sem `organization_id`. No ramo de token o cliente de sessão e o
 * `requireRole` lançam se forem tocados.
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
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaTemplates from "@/app/api/v1/campaign-templates/route";
import * as rotaTemplate from "@/app/api/v1/campaign-templates/[id]/route";
import * as rotaSupressoes from "@/app/api/v1/campaign-suppressions/route";
import * as rotaSupressao from "@/app/api/v1/campaign-suppressions/[id]/route";
import * as rotaCampanhas from "@/app/api/v1/campaigns/route";
import * as rotaCampanha from "@/app/api/v1/campaigns/[id]/route";
import * as rotaMetricas from "@/app/api/v1/campaigns/[id]/metrics/route";
import * as rotaDestinatarios from "@/app/api/v1/campaigns/[id]/recipients/route";
import * as rotaModelos from "@/app/api/v1/campaigns/modelos/route";
import * as rotaPrevia from "@/app/api/v1/campaigns/preview/route";
import * as rotaAcao from "@/app/api/v1/campaigns/[id]/[acao]/route";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(),
  mfaEmDividaEstrita: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
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
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CANAL_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CANAL_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CAMP_A = "11111111-1111-4111-8111-111111111111";
const CAMP_B = "12121212-1212-4121-8121-121212121212";
const DEST_A = "55555555-5555-4555-8555-555555555555";
const DEST_B = "56565656-5656-4565-8565-565656565656";
const TPL_A = "22222222-2222-4222-8222-222222222222";
const TPL_B = "23232323-2323-4232-8232-232323232323";
const SUP_A = "33333333-3333-4333-8333-333333333333";
const SUP_B = "34343434-3434-4343-8343-343434343434";
const CONTATO_A = "44444444-4444-4444-8444-444444444444";
const CONTATO_B = "45454545-4545-4454-8454-454545454545";
/** Escopos do token que cobrem os dois métodos da R2. */
const TODOS_OS_ESCOPOS = ["mcp:read", "mcp:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";
/**
 * Recorte válido para a prévia: o `refine` do filtro exige ao menos um critério, e
 * `{}` sai com 422. `limite: 1` faz a leitura de contatos parar na primeira página:
 * a segunda pede o cursor com `or`, que o dublê registra mas não aplica.
 */
const PUBLICO_DA_PREVIA = { incluir_contatos: [CONTATO_A], limite: 1 };

const CAMPANHA_A = {
  id: CAMP_A,
  organization_id: ORG_A,
  name: "Campanha de A",
  description: null,
  status: "draft",
  channel_session_id: CANAL_A,
  message_body: "Olá",
  message_mode: "text",
  provider_template_name: null,
  provider_template_language: null,
  provider_template_variables: {},
  base_legal: "consent",
  lia_ref: null,
  audience_filter: {},
  audience_version: 1,
  content_version: 1,
  snapshot_total: 0,
  snapshot_eligible: 0,
  snapshot_excluded: 0,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
  pipeline_id: null,
  stage_id: null,
  agent_id: null,
  velocidade: "gradual",
  split_messages: false,
  created_by: null,
  created_at: "2026-10-01T10:00:00Z",
};

const CAMPANHA_B = { ...CAMPANHA_A, id: CAMP_B, organization_id: ORG_B, name: "Campanha de B", channel_session_id: CANAL_B };

const DESTINATARIO_A = {
  id: DEST_A,
  organization_id: ORG_A,
  campaign_id: CAMP_A,
  contact_id: CONTATO_A,
  channel_session_id: CANAL_A,
  status: "pending",
  eligibility_status: "eligible",
  exclusion_reason: null,
  sent_at: null,
  delivered_at: null,
  read_at: null,
  replied_at: null,
  opted_out_at: null,
  last_error_code: null,
  last_error_detail: null,
  created_at: "2026-10-01T10:05:00Z",
};

const DESTINATARIO_B = {
  ...DESTINATARIO_A,
  id: DEST_B,
  organization_id: ORG_B,
  campaign_id: CAMP_B,
  contact_id: CONTATO_B,
  channel_session_id: CANAL_B,
};

const TEMPLATE_A = { id: TPL_A, organization_id: ORG_A, name: "Texto de A", body: "Olá de A", created_by: null, updated_by: null, created_at: "2026-10-01T09:00:00Z" };
const TEMPLATE_B = { ...TEMPLATE_A, id: TPL_B, organization_id: ORG_B, name: "Texto de B", body: "Olá de B" };

const SUPRESSAO_A = {
  id: SUP_A,
  organization_id: ORG_A,
  contact_id: null,
  recipient_address_hash: "hash-a",
  address_tail: "0001",
  reason: null,
  source: "manual",
  created_by: null,
  created_at: "2026-10-01T09:30:00Z",
};
const SUPRESSAO_B = { ...SUPRESSAO_A, id: SUP_B, organization_id: ORG_B, recipient_address_hash: "hash-b", address_tail: "0002" };

const CONTATO_DE_A = { id: CONTATO_A, organization_id: ORG_A, kind: "person", name: "Contato de A", display_name: null, is_blocked: false };
const CONTATO_DE_B = { ...CONTATO_DE_A, id: CONTATO_B, organization_id: ORG_B, name: "Contato de B" };

/** Linhas das DUAS organizações: o dublê precisa ver as duas para acusar vazamento. */
const LINHAS = {
  campaigns: [CAMPANHA_A, CAMPANHA_B],
  campaign_recipients: [DESTINATARIO_A, DESTINATARIO_B],
  campaign_templates: [TEMPLATE_A, TEMPLATE_B],
  campaign_suppressions: [SUPRESSAO_A, SUPRESSAO_B],
  channel_sessions: [
    { id: CANAL_A, organization_id: ORG_A, provider: "waha", status: "connected" },
    { id: CANAL_B, organization_id: ORG_B, provider: "waha", status: "connected" },
  ],
  contacts: [CONTATO_DE_A, CONTATO_DE_B],
};

function novoFalso() {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas: LINHAS });
}

let falso: ReturnType<typeof novoFalso>;

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function reqJson(corpo: unknown, token?: string, metodo = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/v1/campaigns/x", {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(corpo),
  });
}

function reqVazio(token?: string, metodo = "GET"): NextRequest {
  return new NextRequest("http://localhost/api/v1/campaigns/x", {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function reqComCanal(token?: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/campaigns/modelos?channel_session_id=${CANAL_A}`, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function paramsDe(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** A sessão de A: `requireRole` resolve e o cliente de sessão é o dublê. */
function sessaoDeA(): void {
  vi.mocked(requireRole).mockResolvedValueOnce({
    ok: true,
    user: { id: USER_A, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org A", role: "manager" },
  } as never);
  vi.mocked(createClient).mockResolvedValueOnce(falso.cliente as never);
}

function sessaoNegada(): void {
  vi.mocked(requireRole).mockResolvedValueOnce({
    ok: false,
    response: new Response(null, { status: 403 }),
  } as never);
}

async function corpoDe<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Os quatro casos de recusa que valem para todo método. `escopoOutro` é o escopo
 * da OUTRA operação (mcp:read num método de escrita, mcp:write num GET).
 */
function casosDeNegacao(cfg: {
  chamar: (token: string | undefined) => Promise<Response>;
  escopoOutro: string;
  resource: string;
}) {
  it("token sem o escopo deste método é recusado (403), sem escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager", [cfg.escopoOutro]);
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (agent, rank de manager exigido) é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "agent");
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem tocar no banco", async () => {
    // Primeira chamada (balde do token) passa; a segunda (teto da ORGANIZAÇÃO) recusa.
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true, count: 1, limit: 30 } as never)
      .mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão continua com o mesmo portão (requireRole com manager)", async () => {
    sessaoNegada();
    const res = await cfg.chamar(undefined);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: cfg.resource }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  // Cliente admin do token: o dublê. Sem a sessão, o mesmo dublê não existe.
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
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
// campaign-templates — GET (lista) e POST (cria)
// ===========================================================================
describe("GET /campaign-templates — lista", () => {
  it("token de A alcança a copia de A e não a de B", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaTemplates.GET(reqVazio(TOKEN_A));
    expect(res.status).toBe(200);
    const ids = (await corpoDe<{ data: Array<{ id: string }> }>(res)).data.map((l) => l.id);
    expect(ids).toContain(TPL_A);
    expect(ids).not.toContain(TPL_B);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a copia de A (lista só de B)", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaTemplates.GET(reqVazio(TOKEN_B));
    expect(res.status).toBe(200);
    const ids = (await corpoDe<{ data: Array<{ id: string }> }>(res)).data.map((l) => l.id);
    expect(ids).not.toContain(TPL_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("sessão de A lista as próprias copias (2xx, sem Authorization)", async () => {
    sessaoDeA();
    const res = await rotaTemplates.GET(reqVazio());
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "campaign_templates" }));
  });

  casosDeNegacao({
    chamar: (t) => rotaTemplates.GET(reqVazio(t)),
    escopoOutro: "mcp:write",
    resource: "campaign_templates",
  });
});

describe("POST /campaign-templates — guarda uma copy", () => {
  it("token de A cria a copy na organização A, sem autor de pessoa", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaTemplates.POST(reqJson({ name: "Texto novo", body: "Olá" }, TOKEN_A));
    expect(res.status).toBe(201);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    const nova = linhasDaTabela(falso, "campaign_templates").find((l) => l.name === "Texto novo");
    expect(nova).toMatchObject({ organization_id: ORG_A, created_by: null, updated_by: null });
  });

  it("token de B cria só na organização B; a copy de A segue intacta", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaTemplates.POST(reqJson({ name: "Texto de B novo", body: "x" }, TOKEN_B));
    expect(res.status).toBe(201);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    const nova = linhasDaTabela(falso, "campaign_templates").find((l) => l.name === "Texto de B novo");
    expect(nova?.organization_id).toBe(ORG_B);
    expect(linhasDaTabela(falso, "campaign_templates").find((l) => l.id === TPL_A)).toEqual(TEMPLATE_A);
  });

  it("corpo inválido → 422 com o token de A, sem escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaTemplates.POST(reqJson({ name: "" }, TOKEN_A));
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaTemplates.POST(reqJson({ name: "Texto", body: "x" }, t)),
    escopoOutro: "mcp:read",
    resource: "campaign_templates",
  });
});

describe("PATCH /campaign-templates/[id] — reescreve a copy", () => {
  it("token de A reescreve a copy de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaTemplate.PATCH(reqJson({ name: "Texto de A renomeado" }, TOKEN_A, "PATCH"), paramsDe(TPL_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_templates").find((l) => l.id === TPL_A)?.name).toBe("Texto de A renomeado");
  });

  it("token de B não alcança a copy de A (404), e a copy de A segue a mesma", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaTemplate.PATCH(reqJson({ name: "Invadido" }, TOKEN_B, "PATCH"), paramsDe(TPL_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_templates").find((l) => l.id === TPL_A)?.name).toBe("Texto de A");
  });

  casosDeNegacao({
    chamar: (t) => rotaTemplate.PATCH(reqJson({ name: "x" }, t, "PATCH"), paramsDe(TPL_A)),
    escopoOutro: "mcp:read",
    resource: "campaign_templates",
  });
});

describe("DELETE /campaign-templates/[id] — tira da lista", () => {
  it("token de A tira a copy de A da lista", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaTemplate.DELETE(reqVazio(TOKEN_A, "DELETE"), paramsDe(TPL_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_templates").some((l) => l.id === TPL_A)).toBe(false);
  });

  it("token de B não alcança a copy de A (404), e ela continua na lista", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaTemplate.DELETE(reqVazio(TOKEN_B, "DELETE"), paramsDe(TPL_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_templates").some((l) => l.id === TPL_A)).toBe(true);
  });

  casosDeNegacao({
    chamar: (t) => rotaTemplate.DELETE(reqVazio(t, "DELETE"), paramsDe(TPL_A)),
    escopoOutro: "mcp:read",
    resource: "campaign_templates",
  });
});

// ===========================================================================
// campaign-suppressions — GET, POST, DELETE
// ===========================================================================
describe("GET /campaign-suppressions — lista de exclusão", () => {
  it("token de A lista a exclusão de A e não a de B", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSupressoes.GET(reqVazio(TOKEN_A));
    expect(res.status).toBe(200);
    const ids = (await corpoDe<{ data: Array<{ id: string }> }>(res)).data.map((l) => l.id);
    expect(ids).toContain(SUP_A);
    expect(ids).not.toContain(SUP_B);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a exclusão de A (lista só de B)", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaSupressoes.GET(reqVazio(TOKEN_B));
    const ids = (await corpoDe<{ data: Array<{ id: string }> }>(res)).data.map((l) => l.id);
    expect(ids).not.toContain(SUP_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("sessão de A lista as próprias exclusões (2xx, sem Authorization)", async () => {
    sessaoDeA();
    const res = await rotaSupressoes.GET(reqVazio());
    expect(res.status).toBe(200);
  });

  casosDeNegacao({
    chamar: (t) => rotaSupressoes.GET(reqVazio(t)),
    escopoOutro: "mcp:write",
    resource: "campaign_suppressions",
  });
});

describe("POST /campaign-suppressions — põe um número na lista", () => {
  it("token de A põe o número na lista da organização A, com autor nulo e o id do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSupressoes.POST(reqJson({ address: "+5511999990001", reason: "Pediu" }, TOKEN_A));
    expect(res.status).toBe(201);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    const nova = linhasDaTabela(falso, "campaign_suppressions").find((l) => l.address_tail === "0001" && l.id !== SUP_A);
    expect(nova).toMatchObject({ organization_id: ORG_A, created_by: null });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de A aceita contato da própria organização", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSupressoes.POST(reqJson({ address: "+5511999990002", contact_id: CONTATO_A }, TOKEN_A));
    expect(res.status).toBe(201);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B com o contato de A no corpo → 404, sem inserir nada", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const antes = linhasDaTabela(falso, "campaign_suppressions").length;
    const res = await rotaSupressoes.POST(reqJson({ address: "+5511999990003", contact_id: CONTATO_A }, TOKEN_B));
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_suppressions").length).toBe(antes);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão de A com o contato de B no corpo → 404, sem inserir nada (a conferência vale na sessão também)", async () => {
    sessaoDeA();
    const antes = linhasDaTabela(falso, "campaign_suppressions").length;
    const res = await rotaSupressoes.POST(reqJson({ address: "+5511999990005", contact_id: CONTATO_B }));
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_suppressions").length).toBe(antes);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaSupressoes.POST(reqJson({ address: "+5511999990004" }, t)),
    escopoOutro: "mcp:read",
    resource: "campaign_suppressions",
  });
});

describe("DELETE /campaign-suppressions/[id] — tira da lista de exclusão", () => {
  it("token de A tira a exclusão de A, audita com o id do token e nenhum autor de pessoa", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSupressao.DELETE(reqVazio(TOKEN_A, "DELETE"), paramsDe(SUP_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_suppressions").some((l) => l.id === SUP_A)).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B não alcança a exclusão de A (404), sem auditoria e sem apagar", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaSupressao.DELETE(reqVazio(TOKEN_B, "DELETE"), paramsDe(SUP_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(linhasDaTabela(falso, "campaign_suppressions").some((l) => l.id === SUP_A)).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaSupressao.DELETE(reqVazio(t, "DELETE"), paramsDe(SUP_A)),
    escopoOutro: "mcp:read",
    resource: "campaign_suppressions",
  });
});

// ===========================================================================
// campaigns — lista, criação, detalhe, edição, métricas, destinatários, modelos, prévia
// ===========================================================================
describe("GET /campaigns — lista", () => {
  it("token de A lista as campanhas de A e não as de B", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaCampanhas.GET(reqVazio(TOKEN_A));
    expect(res.status).toBe(200);
    const ids = (await corpoDe<{ data: Array<{ id: string }> }>(res)).data.map((l) => l.id);
    expect(ids).toContain(CAMP_A);
    expect(ids).not.toContain(CAMP_B);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a campanha de A (lista só de B)", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaCampanhas.GET(reqVazio(TOKEN_B));
    const ids = (await corpoDe<{ data: Array<{ id: string }> }>(res)).data.map((l) => l.id);
    expect(ids).not.toContain(CAMP_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("sessão de A lista as próprias campanhas (2xx, sem Authorization)", async () => {
    sessaoDeA();
    const res = await rotaCampanhas.GET(reqVazio());
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "campaigns" }));
  });

  casosDeNegacao({
    chamar: (t) => rotaCampanhas.GET(reqVazio(t)),
    escopoOutro: "mcp:write",
    resource: "campaigns",
  });
});

describe("POST /campaigns — cria um rascunho", () => {
  const corpo = { name: "Campanha nova", channel_session_id: CANAL_A, base_legal: "consent", message_body: "Olá" };

  it("token de A cria o rascunho na organização A, sem autor de pessoa, e audita com o id do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaCampanhas.POST(reqJson(corpo, TOKEN_A));
    expect(res.status).toBe(201);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    const nova = linhasDaTabela(falso, "campaigns").find((l) => l.name === "Campanha nova");
    expect(nova).toMatchObject({ organization_id: ORG_A, created_by: null, channel_session_id: CANAL_A });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B com o número de A no corpo → 409, sem criar campanha", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const antes = linhasDaTabela(falso, "campaigns").length;
    const res = await rotaCampanhas.POST(reqJson(corpo, TOKEN_B));
    expect(res.status).toBe(409);
    expect(linhasDaTabela(falso, "campaigns").length).toBe(antes);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaCampanhas.POST(reqJson(corpo, t)),
    escopoOutro: "mcp:read",
    resource: "campaigns",
  });
});

describe("GET /campaigns/[id] — detalhe", () => {
  it("token de A lê a campanha de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaCampanha.GET(reqVazio(TOKEN_A), paramsDe(CAMP_A));
    expect(res.status).toBe(200);
    expect((await corpoDe<{ data: { id: string } }>(res)).data.id).toBe(CAMP_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a campanha de A (404)", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaCampanha.GET(reqVazio(TOKEN_B), paramsDe(CAMP_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaCampanha.GET(reqVazio(t), paramsDe(CAMP_A)),
    escopoOutro: "mcp:write",
    resource: "campaigns",
  });
});

describe("PATCH /campaigns/[id] — edita o rascunho", () => {
  it("token de A edita o rascunho de A, sem auditoria (edição de rascunho não audita)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaCampanha.PATCH(reqJson({ name: "Nome novo" }, TOKEN_A, "PATCH"), paramsDe(CAMP_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(linhasDaTabela(falso, "campaigns").find((l) => l.id === CAMP_A)).toMatchObject({
      name: "Nome novo",
      updated_by: null,
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("token de B não alcança o rascunho de A (404), que segue com o nome antigo", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaCampanha.PATCH(reqJson({ name: "Invadido" }, TOKEN_B, "PATCH"), paramsDe(CAMP_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(linhasDaTabela(falso, "campaigns").find((l) => l.id === CAMP_A)?.name).toBe("Campanha de A");
  });

  casosDeNegacao({
    chamar: (t) => rotaCampanha.PATCH(reqJson({ name: "x" }, t, "PATCH"), paramsDe(CAMP_A)),
    escopoOutro: "mcp:read",
    resource: "campaigns",
  });
});

describe("GET /campaigns/[id]/metrics — funil da campanha", () => {
  it("token de A lê o funil da campanha de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaMetricas.GET(reqVazio(TOKEN_A), paramsDe(CAMP_A));
    expect(res.status).toBe(200);
    expect((await corpoDe<{ data: { contagem: { total: number } } }>(res)).data.contagem.total).toBe(1);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança o funil de A (404)", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaMetricas.GET(reqVazio(TOKEN_B), paramsDe(CAMP_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaMetricas.GET(reqVazio(t), paramsDe(CAMP_A)),
    escopoOutro: "mcp:write",
    resource: "campaigns",
  });
});

describe("GET /campaigns/[id]/recipients — quem recebeu", () => {
  it("token de A lê os destinatários de A com o nome do contato (junção sem embed)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaDestinatarios.GET(reqVazio(TOKEN_A), paramsDe(CAMP_A));
    expect(res.status).toBe(200);
    const lista = (await corpoDe<{ data: Array<{ id: string; contacts: unknown }> }>(res)).data;
    expect(lista.map((l) => l.id)).toEqual([DEST_A]);
    expect(lista[0]?.contacts).toEqual({ name: "Contato de A", display_name: null });
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança os destinatários de A (lista vazia)", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaDestinatarios.GET(reqVazio(TOKEN_B), paramsDe(CAMP_A));
    expect(res.status).toBe(200);
    expect((await corpoDe<{ data: unknown[] }>(res)).data).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaDestinatarios.GET(reqVazio(t), paramsDe(CAMP_A)),
    escopoOutro: "mcp:write",
    resource: "campaigns",
  });
});

describe("GET /campaigns/modelos — o que o número pode mandar", () => {
  it("token de A lê o modo do número de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaModelos.GET(reqComCanal(TOKEN_A));
    expect(res.status).toBe(200);
    expect((await corpoDe<{ data: { modo: string } }>(res)).data.modo).toBe("text");
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B com o número de A → 409 (o número não é da organização B)", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaModelos.GET(reqComCanal(TOKEN_B));
    expect(res.status).toBe(409);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaModelos.GET(reqComCanal(t)),
    escopoOutro: "mcp:write",
    resource: "campaigns",
  });
});

describe("POST /campaigns/preview — prévia do público, sem gravar", () => {
  it("token de A vê o público de A e não o nome de um contato de B", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaPrevia.POST(reqJson({ audience_filter: PUBLICO_DA_PREVIA, message_body: "Olá" }, TOKEN_A));
    expect(res.status).toBe(200);
    const corpo = await corpoDe<{ data: { total: number; amostra: Array<{ nome: string | null }> } }>(res);
    // Prova que a prévia chegou à leitura de contatos (não parou no 422 nem no 404).
    expect(corpo.data.total).toBe(1);
    expect(corpo.data.amostra.map((a) => a.nome)).toEqual(["Contato de A"]);
    expect(JSON.stringify(corpo)).not.toContain("Contato de B");
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  it("token de B com o contato de A em incluir_contatos não vê esse contato na prévia", async () => {
    tokenDe(ORG_B, TOKEN_B, "manager");
    const res = await rotaPrevia.POST(
      reqJson({ audience_filter: { incluir_contatos: [CONTATO_A], limite: 1 }, message_body: "Olá" }, TOKEN_B),
    );
    expect(res.status).toBe(200);
    const corpo = await corpoDe<{ data: { total: number; amostra: Array<{ nome: string | null }> } }>(res);
    // O incluído à mão é buscado com `organization_id` de B: o de A não entra.
    expect(corpo.data.amostra.map((a) => a.nome)).toEqual(["Contato de B"]);
    expect(corpo.data.total).toBe(1);
    expect(JSON.stringify(corpo)).not.toContain("Contato de A");
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaPrevia.POST(reqJson({ audience_filter: PUBLICO_DA_PREVIA, message_body: "x" }, t)),
    escopoOutro: "mcp:read",
    resource: "campaigns",
  });
});

// ===========================================================================
// Fica só de sessão: campaigns/[id]/[acao] (inicia, retoma e testa envio)
// ===========================================================================
describe("POST /campaigns/[id]/[acao] — FICA SÓ DE SESSÃO (envia a cliente final)", () => {
  it("token sem cookie → 401 e o cliente admin nunca é aberto (iniciar e testar)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    for (const acao of ["iniciar", "testar"]) {
      const res = await rotaAcao.POST(reqJson({}, TOKEN_A), {
        params: Promise.resolve({ id: CAMP_A, acao }),
      });
      expect(res.status).toBe(401);
    }
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PUBLIC_PATHS — borda do proxy
// ===========================================================================
describe("PUBLIC_PATHS — borda do proxy", () => {
  const COM_ID = [
    "/api/v1/campaign-suppressions/[id]",
    "/api/v1/campaign-templates/[id]",
    "/api/v1/campaigns/[id]",
    "/api/v1/campaigns/[id]/metrics",
    "/api/v1/campaigns/[id]/recipients",
  ];
  const LITERAIS = [
    "/api/v1/campaign-suppressions",
    "/api/v1/campaign-templates",
    "/api/v1/campaigns",
    "/api/v1/campaigns/modelos",
    "/api/v1/campaigns/preview",
  ];

  it("libera os caminhos com id em forma de UUID e os literais", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", CAMP_A))).toBe(true);
    for (const c of LITERAIS) expect(isPublicPath(c)).toBe(true);
  });

  it("não libera id fora da forma de UUID (só nos caminhos com [id])", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", "abc"))).toBe(false);
  });

  it("não libera sub-path /x em nenhum caminho da lista", () => {
    for (const c of [...COM_ID, ...LITERAIS]) expect(isPublicPath(`${c}/x`)).toBe(false);
  });

  it("modelos e preview são irmãos literais: não entram pela forma de [id]", () => {
    expect(isPublicPath("/api/v1/campaigns/abc")).toBe(false);
    expect(isPublicPath("/api/v1/campaigns/modelos")).toBe(true);
    expect(isPublicPath("/api/v1/campaigns/preview")).toBe(true);
  });

  it("campaigns/[id]/[acao] fica de fora: o caminho de ação não ganha porta", () => {
    expect(isPublicPath(`/api/v1/campaigns/${CAMP_A}/iniciar`)).toBe(false);
    expect(isPublicPath(`/api/v1/campaigns/${CAMP_A}/testar`)).toBe(false);
  });
});
