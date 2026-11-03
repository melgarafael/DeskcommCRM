/**
 * Token de integração nas rotas de `ai/memory` e `ai/skills` (Spec 33, fatia R1).
 *
 * Cada método tem 6 casos:
 *  - token de A alcança o recurso de A (2xx, nada de B lido ou escrito);
 *  - token de B não alcança o recurso de A (404, ou lista só de B);
 *  - token sem o escopo exigido → 403;
 *  - token abaixo do papel (tokenRole admin) → 403;
 *  - acima do teto do token → 429 com Retry-After, sem tocar no banco;
 *  - sessão continua com o mesmo portão (`requireRole` com o papel da tabela).
 *
 * O ramo de token usa o cliente admin falso (`criarClienteAdminFalso`), que
 * acusa cadeia sem `organization_id` (ou RPC com outra organização).
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
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaMemory from "@/app/api/v1/ai/memory/route";
import * as rotaMemoryEntries from "@/app/api/v1/ai/memory/entries/route";
import * as rotaMemoryEntry from "@/app/api/v1/ai/memory/entries/[id]/route";
import * as rotaMemoryVersion from "@/app/api/v1/ai/memory/versions/[id]/route";
import * as rotaSkills from "@/app/api/v1/ai/skills/route";
import * as rotaSkillsImport from "@/app/api/v1/ai/skills/import/route";
import * as rotaSkill from "@/app/api/v1/ai/skills/[name]/route";
import * as rotaSkillVersions from "@/app/api/v1/ai/skills/[name]/versions/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
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
const ID_A = "66666666-6666-4666-8666-666666666666";
const ID_B = "77777777-7777-4777-8777-777777777777";
const NOME_SKILL_A = "minha-skill";
const NOME_SKILL_B = "sua-skill";
const NOME_SKILL_GLOBAL = "objecao-preco"; // catálogo de plataforma (organization_id null)
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const MEMORY_VERSION_A = {
  id: ID_A,
  organization_id: ORG_A,
  version_number: 1,
  content: "conteúdo da versão A",
  created_at: "2026-08-01T10:00:00Z",
};
const MEMORY_VERSION_B = { ...MEMORY_VERSION_A, id: ID_B, organization_id: ORG_B };

const ID_ENTRY_A = "c1000000-0000-4000-8000-000000000001";
const ID_ENTRY_B = "c1000000-0000-4000-8000-000000000002";
const MEMORY_ENTRY_A = {
  id: ID_ENTRY_A,
  organization_id: ORG_A,
  title: "Entrada A",
  body: "corpo A",
  source: "manual",
  status: "active",
  created_by: "user-a",
  valid_until: null,
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
};
const MEMORY_ENTRY_B = { ...MEMORY_ENTRY_A, id: ID_ENTRY_B, organization_id: ORG_B };

const ID_VER_SKILL_A = "e1000000-0000-4000-8000-000000000001";
const ID_VER_SKILL_B = "e1000000-0000-4000-8000-000000000002";
const ID_VER_SKILL_GLOBAL = "e1000000-0000-4000-8000-000000000003";
const SKILL_VERSION_A = {
  id: ID_VER_SKILL_A,
  organization_id: ORG_A,
  name: NOME_SKILL_A,
  description: "Skill A",
  body: "corpo A",
  matcher: { any_keywords: ["x"] },
  forked_from_version_id: null,
  created_at: "2026-08-01T10:00:00Z",
};
const SKILL_VERSION_B = { ...SKILL_VERSION_A, id: ID_VER_SKILL_B, name: NOME_SKILL_B, organization_id: ORG_B };
// Catálogo de plataforma: organization_id NULL — leitura legítima para todas as orgs, nunca escrita.
const SKILL_VERSION_GLOBAL = {
  id: ID_VER_SKILL_GLOBAL,
  organization_id: null,
  name: NOME_SKILL_GLOBAL,
  description: "Skill global de plataforma",
  body: "corpo global",
  matcher: { any_keywords: ["g"] },
  forked_from_version_id: null,
  created_at: "2026-08-01T10:00:00Z",
};

const POINTER_A = { organization_id: ORG_A, name: NOME_SKILL_A, version_id: ID_VER_SKILL_A, updated_at: "2026-08-01T10:00:00Z" };
const POINTER_B = { organization_id: ORG_B, name: NOME_SKILL_B, version_id: ID_VER_SKILL_B, updated_at: "2026-08-01T10:00:00Z" };
const POINTER_GLOBAL = { organization_id: null, name: NOME_SKILL_GLOBAL, version_id: ID_VER_SKILL_GLOBAL, updated_at: "2026-08-01T10:00:00Z" };

/** Linhas das DUAS organizações: o dublê precisa ver as duas para acusar vazamento. */
const LINHAS = {
  org_memory_pointers: [],
  org_memory_versions: [MEMORY_VERSION_A, MEMORY_VERSION_B],
  org_memory_entries: [MEMORY_ENTRY_A, MEMORY_ENTRY_B],
  skill_pointers: [POINTER_A, POINTER_B, POINTER_GLOBAL],
  skill_versions: [SKILL_VERSION_A, SKILL_VERSION_B, SKILL_VERSION_GLOBAL],
};

/**
 * Tabelas SEM filtro obrigatório de `organization_id` neste teste:
 * - `skill_versions` / `skill_pointers`: aceitam `organization_id` NULL (catálogo
 *   global de plataforma). A leitura do catálogo global (`... IS NULL`) é
 *   legítima para todas as organizações; nunca é escrita por token.
 */
function novoFalso() {
  return criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: LINHAS,
    tabelasSemOrganizacao: ["skill_versions", "skill_pointers"],
  });
}

let falso: ReturnType<typeof novoFalso>;

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function reqJson(corpo: unknown, token?: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/ai/memory/x", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(corpo),
  });
}

function reqVazio(token?: string, metodo = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/v1/ai/memory/x", {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function paramsDeId(id: string) {
  return { params: Promise.resolve({ id }) };
}

function paramsDeName(name: string) {
  return { params: Promise.resolve({ name }) };
}

/** Os 4 casos de recusa que valem para todo método: escopo, papel, teto e sessão. */
function casosDeNegacao(cfg: {
  chamar: (token: string | undefined) => Promise<Response>;
  papel: Role;
  escopoExigido: string;
  resource: string;
}) {
  it("token sem o escopo exigido é recusado (403), sem escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", TODOS_OS_ESCOPOS.filter((e) => e !== cfg.escopoExigido));
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (tokenRole admin) é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem tocar no banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão continua com o mesmo portão (requireRole com o papel da tabela)", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await cfg.chamar(undefined);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(cfg.papel, expect.objectContaining({ resource: cfg.resource }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
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
// GET /ai/memory — memória da org (receita B: GET config:read)
// ===========================================================================
describe("GET /ai/memory — memória da org", () => {
  it("token de A alcança o recurso de A e só ele", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMemory.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { entries: unknown[]; versions: unknown[] } };
    expect(corpo.data.entries.map((e) => (e as { organization_id: string }).organization_id)).toEqual([ORG_A]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("token de B vê só o acervo de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaMemory.GET(reqVazio(TOKEN_B, "GET"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { entries: unknown[]; versions: unknown[] } };
    expect(corpo.data.entries.map((e) => (e as { organization_id: string }).organization_id)).toEqual([ORG_B]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token sem config:read (só config:write) é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ["config:write"]);
    const res = await rotaMemory.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaMemory.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(403);
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMemory.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão continua com o mesmo portão: requireRole('agent', ...)", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await rotaMemory.GET(reqVazio(undefined, "GET"));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "org_memory_get" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
});

// ===========================================================================
// POST /ai/memory — publica memória (receita A: config:write)
// ===========================================================================
describe("POST /ai/memory — publica memória", () => {
  it("token de A publica na organização de A, com auditoria do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMemory.POST(reqJson({ content: "novo conteúdo A" }, TOKEN_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B publica na organização de B, nada de A lido nem escrito", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaMemory.POST(reqJson({ content: "novo conteúdo B" }, TOKEN_B));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_B, organizationId: ORG_B }),
    );
  });

  casosDeNegacao({
    chamar: (t) => rotaMemory.POST(reqJson({ content: "negado" }, t)),
    papel: "admin",
    escopoExigido: "config:write",
    resource: "org_memory_publish",
  });
});

// ===========================================================================
// POST /ai/memory/entries — cria entrada (receita A: config:write)
// ===========================================================================
describe("POST /ai/memory/entries — cria entrada", () => {
  it("token de A cria a entrada na organização de A, com auditoria do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMemoryEntries.POST(
      reqJson({ title: "Nova entrada A", body: "corpo da entrada A" }, TOKEN_A),
    );
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B cria na organização de B, nada de A lido nem escrito", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaMemoryEntries.POST(
      reqJson({ title: "Nova entrada B", body: "corpo da entrada B" }, TOKEN_B),
    );
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_B, organizationId: ORG_B }),
    );
  });

  casosDeNegacao({
    chamar: (t) => rotaMemoryEntries.POST(reqJson({ title: "negado", body: "x" }, t)),
    papel: "manager",
    escopoExigido: "config:write",
    resource: "org_memory_entry_create",
  });
});

// ===========================================================================
// PATCH /ai/memory/entries/[id] — atualiza entrada (receita A: config:write)
// ===========================================================================
describe("PATCH /ai/memory/entries/[id] — atualiza entrada", () => {
  it("token de A atualiza a entrada de A e audita com o id do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMemoryEntry.PATCH(
      reqJson({ status: "archived" }, TOKEN_A),
      paramsDeId(ID_ENTRY_A),
    );
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B não alcança a entrada de A (404), sem escrita", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaMemoryEntry.PATCH(
      reqJson({ status: "archived" }, TOKEN_B),
      paramsDeId(ID_ENTRY_A),
    );
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaMemoryEntry.PATCH(reqJson({ status: "archived" }, t), paramsDeId(ID_ENTRY_A)),
    papel: "manager",
    escopoExigido: "config:write",
    resource: "org_memory_entry_update",
  });
});

// ===========================================================================
// GET /ai/memory/versions/[id] — versão específica (receita B)
// ===========================================================================
describe("GET /ai/memory/versions/[id] — versão específica", () => {
  it("token de A alcança a versão de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMemoryVersion.GET(reqVazio(TOKEN_A, "GET"), paramsDeId(ID_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { id: string } };
    expect(corpo.data.id).toBe(ID_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a versão de A (404)", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaMemoryVersion.GET(reqVazio(TOKEN_B, "GET"), paramsDeId(ID_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token sem config:read é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ["config:write"]);
    const res = await rotaMemoryVersion.GET(reqVazio(TOKEN_A, "GET"), paramsDeId(ID_A));
    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaMemoryVersion.GET(reqVazio(TOKEN_A, "GET"), paramsDeId(ID_A));
    expect(res.status).toBe(403);
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMemoryVersion.GET(reqVazio(TOKEN_A, "GET"), paramsDeId(ID_A));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão continua com o mesmo portão: requireRole('agent', ...)", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await rotaMemoryVersion.GET(reqVazio(undefined, "GET"), paramsDeId(ID_A));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "org_memory_version_get" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
});

// ===========================================================================
// GET /ai/skills — lista de skills (receita B: config:read)
// ===========================================================================
describe("GET /ai/skills — lista de skills", () => {
  it("token de A alcança as skills de A e só elas", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkills.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { installed: unknown[] } };
    expect(corpo.data.installed.map((i) => (i as { name: string }).name)).toEqual([NOME_SKILL_A]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("token de B vê só as skills de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaSkills.GET(reqVazio(TOKEN_B, "GET"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { installed: unknown[] } };
    expect(corpo.data.installed.map((i) => (i as { name: string }).name)).toEqual([NOME_SKILL_B]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token sem config:read (só config:write) é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ["config:write"]);
    const res = await rotaSkills.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSkills.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(403);
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkills.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão continua com o mesmo portão: requireRole('agent', ...)", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await rotaSkills.GET(reqVazio(undefined, "GET"));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "ai_skills_list" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
});

// ===========================================================================
// GET /ai/skills/[name] — lê uma skill (receita B: config:read)
// ===========================================================================
describe("GET /ai/skills/[name] — lê uma skill", () => {
  it("token de A alcança a skill de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkill.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { name: string } };
    expect(corpo.data.name).toBe(NOME_SKILL_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a skill de A (404)", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaSkill.GET(reqVazio(TOKEN_B, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token sem config:read é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ["config:write"]);
    const res = await rotaSkill.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSkill.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(403);
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkill.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão continua com o mesmo portão: requireRole('agent', ...)", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await rotaSkill.GET(reqVazio(undefined, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "ai_skills_get" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
});

// ===========================================================================
// DELETE /ai/skills/[name] — desinstala skill (receita A: config:write)
// ===========================================================================
describe("DELETE /ai/skills/[name] — desinstala skill", () => {
  it("token de A desinstala a skill de A e audita com o id do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkill.DELETE(reqVazio(TOKEN_A, "DELETE"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B não alcança a skill de A (404), sem escrita", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaSkill.DELETE(reqVazio(TOKEN_B, "DELETE"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaSkill.DELETE(reqVazio(t, "DELETE"), paramsDeName(NOME_SKILL_A)),
    papel: "manager",
    escopoExigido: "config:write",
    resource: "ai_skills_delete",
  });
});

// ===========================================================================
// GET /ai/skills/[name]/versions — histórico de versões (receita B: config:read)
// ===========================================================================
describe("GET /ai/skills/[name]/versions — histórico de versões", () => {
  it("token de A alcança o histórico da skill de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkillVersions.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { versions: unknown[] } };
    expect(corpo.data.versions.map((v) => (v as { id: string }).id)).toEqual([ID_VER_SKILL_A]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  // ===========================================================================
  // Skill GLOBAL do catálogo de plataforma (organization_id null): leitura
  // legítima para toda organização, nunca escrita.
  // ===========================================================================
  describe("GET /ai/skills — catálogo global de plataforma", () => {
    it("token de B lê o catálogo global (skill global aparece)", async () => {
      tokenDe(ORG_B, TOKEN_B, "admin");
      const res = await rotaSkills.GET(reqVazio(TOKEN_B, "GET"));
      expect(res.status).toBe(200);
      const corpo = (await res.json()) as { data: { installed: unknown[]; catalog: unknown[] } };
      // B só tem sua skill instalada; o global não é "installed" de B.
      expect(corpo.data.installed.map((i) => (i as { name: string }).name)).toEqual([NOME_SKILL_B]);
      // O catálogo expõe a skill global (que B não instalou).
      expect(corpo.data.catalog.map((c) => (c as { name: string }).name)).toContain(NOME_SKILL_GLOBAL);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    });
  });

  describe("DELETE /ai/skills/[name] — skill global não é desinstalável por token", () => {
    it("token de B tenta deletar a skill global → 404, sem escrita", async () => {
      tokenDe(ORG_B, TOKEN_B, "admin");
      const res = await rotaSkill.DELETE(reqVazio(TOKEN_B, "DELETE"), paramsDeName(NOME_SKILL_GLOBAL));
      expect(res.status).toBe(404);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });
  });

  describe("GET /ai/skills/[name] — skill global não vaza ponteiro de A", () => {
    it("token de B lê a skill global e não vê o ponteiro/versão de A", async () => {
      tokenDe(ORG_B, TOKEN_B, "admin");
      const res = await rotaSkill.GET(reqVazio(TOKEN_B, "GET"), paramsDeName(NOME_SKILL_GLOBAL));
      expect(res.status).toBe(200);
      const corpo = (await res.json()) as { data: { version_id: string } };
      expect(corpo.data.version_id).toBe(ID_VER_SKILL_GLOBAL);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    });
  });

  it("token de B não alcança o histórico da skill de A (lista vazia)", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaSkillVersions.GET(reqVazio(TOKEN_B, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { versions: unknown[] } };
    expect(corpo.data.versions).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token sem config:read é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ["config:write"]);
    const res = await rotaSkillVersions.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSkillVersions.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(403);
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkillVersions.GET(reqVazio(TOKEN_A, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão continua com o mesmo portão: requireRole('agent', ...)", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await rotaSkillVersions.GET(reqVazio(undefined, "GET"), paramsDeName(NOME_SKILL_A));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "ai_skills_versions" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
});

// ===========================================================================
// Bloco de borda: PUBLIC_PATHS
// ===========================================================================
describe("PUBLIC_PATHS — borda do proxy", () => {
  const COM_ID = [
    "/api/v1/ai/memory/entries/[id]",
    "/api/v1/ai/memory/versions/[id]",
  ];
  const COM_NAME = ["/api/v1/ai/skills/[name]", "/api/v1/ai/skills/[name]/versions"];
  const LITERAIS = [
    "/api/v1/ai/memory",
    "/api/v1/ai/memory/entries",
    "/api/v1/ai/skills",
  ];

  it("libera os caminhos com id/name em forma válida e os literais", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", ID_A))).toBe(true);
    for (const c of COM_NAME) expect(isPublicPath(c.replace("[name]", NOME_SKILL_A))).toBe(true);
    for (const c of LITERAIS) expect(isPublicPath(c)).toBe(true);
  });

  it("não libera id fora da forma de UUID (só nos caminhos com [id])", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", "abc"))).toBe(false);
  });

  it("não libera name fora da classe aceita (1-120 chars, sem barra)", () => {
    expect(isPublicPath("/api/v1/ai/skills/abc")).toBe(true);
    expect(isPublicPath("/api/v1/ai/skills/a/b")).toBe(false);
    expect(isPublicPath("/api/v1/ai/skills/")).toBe(false);
  });

  it("não libera sub-path /x em nenhum caminho da lista", () => {
    for (const c of [...COM_ID, ...COM_NAME, ...LITERAIS]) expect(isPublicPath(`${c}/x`)).toBe(false);
  });

  it("irmãos só de sessão (import, install, restore) são LIBERADOS pelo proxy (classe [^/]{1,120} casa o literal)", () => {
    // O proxy não distingue método nem irmão literal: [^/]{1,120} casa "import",
    // "install", "restore" e o próprio [name]. O proxy libera; a ROTA é que
    // recusa o token (401) — provado nos casos de "só sessão" abaixo.
    expect(isPublicPath("/api/v1/ai/skills/import")).toBe(true);
    expect(isPublicPath(`/api/v1/ai/skills/${NOME_SKILL_A}/import`)).toBe(true);
    expect(isPublicPath(`/api/v1/ai/skills/${NOME_SKILL_A}/install`)).toBe(true);
    expect(isPublicPath(`/api/v1/ai/skills/${NOME_SKILL_A}/restore`)).toBe(true);
  });
});

// ============================================================================
// Métodos que ficaram SÓ de sessão: PUT [name], POST import
// (install e restore não existem como arquivos de rota nesta fatia).
// O proxy libera o caminho, mas a rota recusa o Bearer com 401 e nunca
// toca createAdminClient.
// ============================================================================
describe("Só sessão — token é recusado com 401, createAdminClient nunca chamado", () => {
  const reqComToken = (metodo: string, caminho: string, corpo?: unknown) =>
    new NextRequest(`http://localhost${caminho}`, {
      method: metodo,
      headers: { authorization: `Bearer ${TOKEN_A}` },
      ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
    });

  it("PUT /ai/skills/[name] com token → 401, createAdminClient não chamado", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const res = await rotaSkill.PUT(
      reqComToken("PUT", `/api/v1/ai/skills/${NOME_SKILL_A}`, {
        description: "d",
        body: "b",
        matcher: { any_keywords: ["x"] },
      }),
      paramsDeName(NOME_SKILL_A),
    );
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });

  it("POST /ai/skills/import com token → 401, createAdminClient não chamado", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const res = await rotaSkillsImport.POST(reqComToken("POST", "/api/v1/ai/skills/import"));
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Item 16 — POST /memory e POST /memory/entries com token de B: não mexe o
// ponteiro/recurso de A.
// ============================================================================
describe("Isolamento de escrita: token de B não move ponteiro nem recurso de A", () => {
  it("POST /memory com token de B: ponteiro de A continua igual", async () => {
    // Pré-popula o ponteiro de A.
    const ponteiroA = { organization_id: ORG_A, version_id: ID_A, updated_at: "2026-08-01T10:00:00Z" };
    const falsoB = criarClienteAdminFalso({
      orgDona: ORG_B,
      linhas: { ...LINHAS, org_memory_pointers: [ponteiroA] },
      tabelasSemOrganizacao: ["skill_versions", "skill_pointers"],
    });
    vi.mocked(createAdminClient).mockReturnValue(falsoB.cliente as never);
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaMemory.POST(reqJson({ content: "novo conteúdo B" }, TOKEN_B));
    expect(res.status).toBe(200);
    // O ponteiro de A não foi movido (continua apontando pra ID_A).
    const ptrA = falsoB.linhas.org_memory_pointers.find((p) => p.organization_id === ORG_A);
    expect(ptrA?.version_id).toBe(ID_A);
    // Nada de A foi lido ou escrito.
    expect(cadeiasForaDaOrganizacao(falsoB.cadeias, ORG_B)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_B, organizationId: ORG_B }),
    );
  });

  it("POST /memory/entries com token de B: entrada de A não é tocada", async () => {
    const falsoB = criarClienteAdminFalso({
      orgDona: ORG_B,
      linhas: { ...LINHAS },
      tabelasSemOrganizacao: ["skill_versions", "skill_pointers"],
    });
    vi.mocked(createAdminClient).mockReturnValue(falsoB.cliente as never);
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaMemoryEntries.POST(
      reqJson({ title: "Nova entrada B", body: "corpo B" }, TOKEN_B),
    );
    expect(res.status).toBe(200);
    // A entrada de A continua intocada (não há linha de A alterada).
    expect(falsoB.linhas.org_memory_entries.some((e) => e.organization_id === ORG_A)).toBe(false);
    // ou a linha de A segue com o título original
    const entradaA = falsoB.linhas.org_memory_entries.find((e) => e.id === ID_ENTRY_A);
    expect(entradaA?.title).toBe("Entrada A");
    expect(cadeiasForaDaOrganizacao(falsoB.cadeias, ORG_B)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_B, organizationId: ORG_B }),
    );
  });
});
