// @vitest-environment node
/**
 * Token de integração nas rotas de `ai/knowledge` (Spec 33, fatia R1, Task 4).
 *
 * As 8 rotas da tabela do plano (11 métodos) têm, por método:
 *  - token de A alcança o recurso de A (2xx, e nada de B lido ou escrito);
 *  - token de B não alcança o recurso de A (404, ou a lista só de B);
 *  - token sem o escopo exigido → 403;
 *  - token abaixo do papel (tokenRole admin) → 403;
 *  - acima do teto do token → 429 com Retry-After, sem tocar no banco;
 *  - sessão continua com o mesmo portão (`requireRole` com o papel da tabela).
 *
 * O banco é `criarClienteAdminFalso`: guarda linhas das duas organizações e
 * acusa cadeia sem `organization_id` (ou RPC com outra organização). O ramo de
 * token usa o cliente admin; o cliente de sessão e o `requireRole` lançam/recusam
 * se o ramo de token os tocar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { isPublicPath } from "@/lib/auth/public-paths";
import type { Role } from "@/lib/auth/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { embedText } from "@/lib/ai/embed";
import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { extrairTextoDoArquivo } from "@/lib/ai/rag/ingest/documento";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaSources from "@/app/api/v1/ai/knowledge/sources/route";
import * as rotaUpload from "@/app/api/v1/ai/knowledge/sources/upload/route";
import * as rotaFonte from "@/app/api/v1/ai/knowledge/sources/[id]/route";
import * as rotaConteudo from "@/app/api/v1/ai/knowledge/sources/[id]/conteudo/route";
import * as rotaTrechos from "@/app/api/v1/ai/knowledge/sources/[id]/trechos/route";
import * as rotaReindex from "@/app/api/v1/ai/knowledge/sources/[id]/reindex/route";
import * as rotaBusca from "@/app/api/v1/ai/knowledge/busca/route";
import * as rotaReindexAll from "@/app/api/v1/ai/knowledge/reindex-all/route";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
  orgAtivaDaApi: vi.fn(),
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
vi.mock("@/lib/ai/embeddings/chave", () => ({ temChaveDeEmbedding: vi.fn() }));
vi.mock("@/lib/ai/embed", () => ({
  embedText: vi.fn(),
  SemChaveDeEmbeddingError: class SemChaveDeEmbeddingError extends Error {},
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/rag/ingest/documento", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/rag/ingest/documento")>()),
  extrairTextoDoArquivo: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures — declaradas antes do uso
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const ID_A = "66666666-6666-4666-8666-666666666666";
const ID_B = "77777777-7777-4777-8777-777777777777";
const ID_AGENTE_A = "88888888-8888-4888-8888-888888888888";
const ID_DOC_A = "99999999-9999-4999-8999-999999999999";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const SOURCE_A = {
  id: ID_A,
  agent_id: null,
  organization_id: ORG_A,
  source_type: "faq",
  name: "FAQ de A",
  status: "ready",
  is_active: true,
  last_index_status: null,
  last_index_error: null,
  last_indexed_at: null,
  chunks_count: 1,
  source_metadata: {},
  active_kb_version_id: "kb-a",
  ingested_at: null,
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
};

const SOURCE_B = {
  ...SOURCE_A,
  id: ID_B,
  organization_id: ORG_B,
  name: "FAQ de B",
  active_kb_version_id: null,
};

const DOC_A = {
  ...SOURCE_A,
  id: ID_DOC_A,
  source_type: "documento",
  name: "Documento de A",
  source_metadata: { blob_path: `${ORG_A}/doc.md`, ext: "md" },
  active_kb_version_id: null,
};

const ITEM_A = {
  id: "item-a1",
  organization_id: ORG_A,
  knowledge_source_id: ID_A,
  question: "Qual o prazo?",
  answer: "Sete dias.",
  tags: [],
  locale: "pt-BR",
  position: 0,
};

const ITEM_B = { ...ITEM_A, id: "item-b1", organization_id: ORG_B, knowledge_source_id: ID_B, question: "Outra?" };

const CHUNK_A = {
  id: "chunk-a1",
  organization_id: ORG_A,
  knowledge_source_id: ID_A,
  kb_version_id: "kb-a",
  position: 0,
  content: "trecho A",
  token_count: 2,
  metadata: {},
};

const AGENTE_A = { id: ID_AGENTE_A, organization_id: ORG_A, name: "Agente de A", config: {} };

const TRECHO_A = {
  chunk_id: "chunk-a1",
  knowledge_source_id: ID_A,
  source_name: "FAQ de A",
  content: "trecho A",
  similarity: 0.9,
};

/** Linhas das DUAS organizações: o dublê precisa ver as duas para acusar vazamento. */
const LINHAS = {
  ai_knowledge_sources: [SOURCE_A, SOURCE_B],
  ai_faq_items: [ITEM_A, ITEM_B],
  ai_chunks: [CHUNK_A],
  ai_agents: [AGENTE_A],
  knowledge_searches: [],
};

/** RPC de busca: devolve trecho só para a organização A, como a RPC real faria por filtro. */
const RPCS = {
  fn_buscar_trechos_das_fontes: (args: Record<string, unknown>) => ({
    data: args.p_organization_id === ORG_A ? [TRECHO_A] : [],
  }),
};

function novoFalso() {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas: LINHAS, rpc: RPCS });
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

function reqJson(corpo: unknown, token?: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/ai/knowledge/x", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(corpo),
  });
}

function reqVazio(token?: string, metodo = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/v1/ai/knowledge/x", {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function reqUpload(token: string | undefined, campos: Record<string, string>): NextRequest {
  const form = new FormData();
  for (const [chave, valor] of Object.entries(campos)) form.set(chave, valor);
  const conteudo = Buffer.from("conteúdo do arquivo");
  const file = new File([conteudo], "material.md", { type: "text/markdown" });
  // No ambiente node do vitest, `File.arrayBuffer` pode não expor `_buffer`;
  // garante um `arrayBuffer` que devolva o conteúdo do arquivo.
  (file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer = async () =>
    conteudo.buffer;
  form.set("file", file);
  return new NextRequest("http://localhost/api/v1/ai/knowledge/sources/upload", {
    method: "POST",
    body: form,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function paramsDe(id: string) {
  return { params: Promise.resolve({ id }) };
}

function corpoFaq(nome: string, extra: Record<string, unknown> = {}) {
  return {
    source_type: "faq",
    name: nome,
    items: [{ question: "Pergunta?", answer: "Resposta." }],
    ...extra,
  };
}

/**
 * Os 4 casos de recusa que valem para todo método: escopo, papel, teto e sessão.
 * `escopoExigido` é o que o token NÃO pode ter (o do método: config:read ou config:write).
 */
function casosDeNegacao(cfg: {
  chamar: (token: string | undefined) => Promise<Response>;
  papel: Role;
  escopoExigido: string;
}) {
  it("token sem o escopo exigido é recusado (403), sem escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", TODOS_OS_ESCOPOS.filter((e) => e !== cfg.escopoExigido));
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(falso.rpcs).toEqual([]);
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
    expect(falso.rpcs).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão continua com o mesmo portão (requireRole com o papel da tabela)", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await cfg.chamar(undefined);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(cfg.papel, expect.objectContaining({ resource: "ai_knowledge" }));
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
  vi.mocked(temChaveDeEmbedding).mockResolvedValue(true);
  vi.mocked(embedText).mockResolvedValue({ embedding: [0.1, 0.2], model: "modelo-teste" } as never);
  vi.mocked(extrairTextoDoArquivo).mockResolvedValue({ texto: "conteúdo extraído" } as never);
});

// ===========================================================================
// GET /ai/knowledge/sources — lista (receita B: sessão por loadAuthUser)
// ===========================================================================
describe("GET /ai/knowledge/sources — lista de fontes", () => {
  it("token de A alcança o recurso de A e só ele", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSources.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string }> };
    expect(corpo.data.map((s) => s.id)).toEqual([ID_A]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("token de B vê só o acervo de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaSources.GET(reqVazio(TOKEN_B, "GET"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string }> };
    expect(corpo.data.map((s) => s.id)).toEqual([ID_B]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token sem config:read (só config:write) é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", ["config:write"]);
    const res = await rotaSources.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await rotaSources.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(403);
  });

  it("acima do teto do token → 429 com Retry-After", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSources.GET(reqVazio(TOKEN_A, "GET"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
  });

  it("sessão continua com o mesmo portão: sem sessão, 401 por loadAuthUser", async () => {
    vi.mocked(loadAuthUser).mockResolvedValueOnce(null);
    const res = await rotaSources.GET(reqVazio(undefined, "GET"));
    expect(res.status).toBe(401);
    expect(loadAuthUser).toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /ai/knowledge/sources — cria fonte (receita A)
// ===========================================================================
describe("POST /ai/knowledge/sources — cria fonte", () => {
  it("token de A cria a fonte na organização de A, com auditoria do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSources.POST(reqJson(corpoFaq("Novo FAQ A"), TOKEN_A));
    expect(res.status).toBe(201);
    expect(falso.cadeias.some((c) => c.tabela === "ai_knowledge_sources" && c.operacao === "insert")).toBe(true);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B com agent_id de A → 404; nada de A lido nem escrito; o 201 não existe para B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaSources.POST(reqJson(corpoFaq("Novo FAQ B", { agent_id: ID_AGENTE_A }), TOKEN_B));
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias.filter((c) => c.tabela === "ai_agents"), ORG_B)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaSources.POST(reqJson(corpoFaq("Negado"), t)),
    papel: "manager",
    escopoExigido: "config:write",
  });

  describe("blob_path do corpo com token: fora da organização → 422", () => {
    it("blob_path de outra organização é recusado antes de qualquer escrita", async () => {
      tokenDe(ORG_A, TOKEN_A, "admin");
      const res = await rotaSources.POST(
        reqJson(corpoFaq("Blob alheio", { source_metadata: { blob_path: `${ORG_B}/x.md` } }), TOKEN_A),
      );
      expect(res.status).toBe(422);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it("blob_path com .. escapando da organização é recusado", async () => {
      tokenDe(ORG_A, TOKEN_A, "admin");
      const res = await rotaSources.POST(
        reqJson(corpoFaq("Blob com ponto", { source_metadata: { blob_path: `${ORG_A}/../${ORG_B}/x.md` } }), TOKEN_A),
      );
      expect(res.status).toBe(422);
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    });
  });
});

// ===========================================================================
// GET /ai/knowledge/sources/[id] — lê uma fonte (receita A)
// ===========================================================================
describe("GET /ai/knowledge/sources/[id] — lê uma fonte", () => {
  it("token de A alcança o recurso de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaFonte.GET(reqVazio(TOKEN_A, "GET"), paramsDe(ID_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { id: string } };
    expect(corpo.data.id).toBe(ID_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança o recurso de A (404)", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaFonte.GET(reqVazio(TOKEN_B, "GET"), paramsDe(ID_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaFonte.GET(reqVazio(t, "GET"), paramsDe(ID_A)),
    papel: "manager",
    escopoExigido: "config:read",
  });
});

// ===========================================================================
// PATCH /ai/knowledge/sources/[id] — atualiza uma fonte (receita A)
// ===========================================================================
describe("PATCH /ai/knowledge/sources/[id] — atualiza uma fonte", () => {
  it("token de A atualiza a fonte de A e audita com o id do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaFonte.PATCH(reqJson({ name: "Nome novo" }, TOKEN_A), paramsDe(ID_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B não alcança a fonte de A (404), sem escrita", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaFonte.PATCH(reqJson({ name: "Nome novo" }, TOKEN_B), paramsDe(ID_A));
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaFonte.PATCH(reqJson({ name: "Nome novo" }, t), paramsDe(ID_A)),
    papel: "manager",
    escopoExigido: "config:write",
  });

  it("token de A com blob_path da organização B no PATCH → 422, sem update", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaFonte.PATCH(
      reqJson({ source_metadata: { blob_path: `${ORG_B}/x.md` } }, TOKEN_A),
      paramsDe(ID_A),
    );
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// DELETE /ai/knowledge/sources/[id] — arquiva uma fonte (receita A)
// ===========================================================================
describe("DELETE /ai/knowledge/sources/[id] — arquiva uma fonte", () => {
  it("token de A arquiva a fonte de A e audita", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaFonte.DELETE(reqVazio(TOKEN_A, "DELETE"), paramsDe(ID_A));
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B não alcança a fonte de A (404), sem escrita", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaFonte.DELETE(reqVazio(TOKEN_B, "DELETE"), paramsDe(ID_A));
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaFonte.DELETE(reqVazio(t, "DELETE"), paramsDe(ID_A)),
    papel: "manager",
    escopoExigido: "config:write",
  });
});

// ===========================================================================
// GET /ai/knowledge/sources/[id]/conteudo — lê o conteúdo (receita A)
// ===========================================================================
describe("GET /ai/knowledge/sources/[id]/conteudo — lê o conteúdo", () => {
  it("token de A lê as perguntas e respostas da fonte de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaConteudo.GET(reqVazio(TOKEN_A, "GET"), paramsDe(ID_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { origem: string; itens: unknown[] } };
    expect(corpo.data.origem).toBe("faq");
    expect(corpo.data.itens).toHaveLength(1);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de A lê o arquivo guardado de um documento, com a extração mockada", async () => {
    falso = criarClienteAdminFalso({
      orgDona: ORG_A,
      linhas: { ...LINHAS, ai_knowledge_sources: [SOURCE_A, SOURCE_B, DOC_A] },
      rpc: RPCS,
    });
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaConteudo.GET(reqVazio(TOKEN_A, "GET"), paramsDe(ID_DOC_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { origem: string; conteudo: string } };
    expect(corpo.data.origem).toBe("arquivo");
    expect(corpo.data.conteudo).toBe("conteúdo extraído");
    expect(extrairTextoDoArquivo).toHaveBeenCalledWith(`${ORG_A}/doc.md`, "md");
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a fonte de A (404)", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaConteudo.GET(reqVazio(TOKEN_B, "GET"), paramsDe(ID_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaConteudo.GET(reqVazio(t, "GET"), paramsDe(ID_A)),
    papel: "manager",
    escopoExigido: "config:read",
  });
});

// ===========================================================================
// GET /ai/knowledge/sources/[id]/trechos — trechos de uma fonte (receita A)
// ===========================================================================
describe("GET /ai/knowledge/sources/[id]/trechos — trechos de uma fonte", () => {
  it("token de A lê os trechos da versão ativa da fonte de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaTrechos.GET(reqVazio(TOKEN_A, "GET"), paramsDe(ID_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { trechos: Array<{ content: string }> } };
    expect(corpo.data.trechos.map((t) => t.content)).toEqual(["trecho A"]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não alcança a fonte de A (404)", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaTrechos.GET(reqVazio(TOKEN_B, "GET"), paramsDe(ID_A));
    expect(res.status).toBe(404);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaTrechos.GET(reqVazio(t, "GET"), paramsDe(ID_A)),
    papel: "manager",
    escopoExigido: "config:read",
  });
});

// ===========================================================================
// POST /ai/knowledge/sources/[id]/reindex — reindexa uma fonte (receita A)
// ===========================================================================
describe("POST /ai/knowledge/sources/[id]/reindex — reindexa uma fonte", () => {
  it("token de A reindexa a fonte de A, com a organização de A no evento", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaReindex.POST(reqVazio(TOKEN_A), paramsDe(ID_A));
    expect(res.status).toBe(200);
    expect(falso.rpcs.some((r) => r.args.p_entity_id === ID_A && r.args.p_organization_id === ORG_A)).toBe(true);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B não alcança a fonte de A (404), sem evento", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaReindex.POST(reqVazio(TOKEN_B), paramsDe(ID_A));
    expect(res.status).toBe(404);
    expect(falso.rpcs).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaReindex.POST(reqVazio(t), paramsDe(ID_A)),
    papel: "manager",
    escopoExigido: "config:write",
  });
});

// ===========================================================================
// POST /ai/knowledge/busca — pergunta ao acervo (receita A)
// ===========================================================================
describe("POST /ai/knowledge/busca — pergunta ao acervo", () => {
  it("token de A busca no acervo de A e a RPC recebe a organização de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaBusca.POST(reqJson({ pergunta: "qual o prazo?" }, TOKEN_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { trechos: unknown[] } };
    expect(corpo.data.trechos).toHaveLength(1);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    // Telemetria de busca HUMANA só na sessão: o token não grava knowledge_searches.
    expect(falso.cadeias.some((c) => c.tabela === "knowledge_searches")).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token de B não alcança o acervo de A: a RPC só recebe as fontes de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaBusca.POST(reqJson({ pergunta: "qual o prazo?" }, TOKEN_B));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { trechos: unknown[] } };
    expect(corpo.data.trechos).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
    const fontesConsultadas = falso.rpcs[0]?.args.p_source_ids as string[];
    expect(fontesConsultadas).toEqual([ID_B]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaBusca.POST(reqJson({ pergunta: "qual o prazo?" }, t)),
    papel: "agent",
    escopoExigido: "config:write",
  });
});

// ===========================================================================
// POST /ai/knowledge/sources/upload — envia arquivo (receita A)
// ===========================================================================
describe("POST /ai/knowledge/sources/upload — envia arquivo", () => {
  it("token de A envia para o prefixo da organização de A, com auditoria do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaUpload.POST(reqUpload(TOKEN_A, { name: "Meu material" }));
    expect(res.status).toBe(201);
    expect(falso.uploads.length).toBeGreaterThan(0);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("token de B com agent_id de A → 404; nenhum arquivo subiu", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaUpload.POST(reqUpload(TOKEN_B, { name: "Material B", agent_id: ID_AGENTE_A }));
    expect(res.status).toBe(404);
    expect(falso.uploads).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaUpload.POST(reqUpload(t, { name: "Material negado" })),
    papel: "manager",
    escopoExigido: "config:write",
  });
});

// ===========================================================================
// POST /ai/knowledge/reindex-all — os 6 casos (receita A)
// ===========================================================================
describe("POST /ai/knowledge/reindex-all — reindexa todos os materiais", () => {
  it("1. token de A reindexa só os materiais de A, com auditoria do token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaReindexAll.POST(reqVazio(TOKEN_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { total: number } };
    expect(corpo.data.total).toBe(1);
    expect(falso.rpcs.some((r) => r.args.p_entity_id === ID_A)).toBe(true);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A, organizationId: ORG_A }),
    );
  });

  it("2. token de B reindexa só os materiais de B: nenhum evento para a fonte de A", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaReindexAll.POST(reqVazio(TOKEN_B));
    expect(res.status).toBe(200);
    expect(falso.rpcs.some((r) => r.args.p_entity_id === ID_A)).toBe(false);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaReindexAll.POST(reqVazio(t)),
    papel: "manager",
    escopoExigido: "config:write",
  });
});

// ===========================================================================
// Bloco de borda: PUBLIC_PATHS
// ===========================================================================
describe("PUBLIC_PATHS — borda do proxy", () => {
  const COM_ID = [
    "/api/v1/ai/knowledge/sources/[id]",
    "/api/v1/ai/knowledge/sources/[id]/conteudo",
    "/api/v1/ai/knowledge/sources/[id]/reindex",
    "/api/v1/ai/knowledge/sources/[id]/trechos",
  ];
  const LITERAIS = [
    "/api/v1/ai/knowledge/busca",
    "/api/v1/ai/knowledge/reindex-all",
    "/api/v1/ai/knowledge/sources",
    "/api/v1/ai/knowledge/sources/upload",
  ];

  it("libera os caminhos com id em forma de UUID e os literais", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", ID_A))).toBe(true);
    for (const c of LITERAIS) expect(isPublicPath(c)).toBe(true);
  });

  it("não libera id fora da forma de UUID (só nos caminhos com [id])", () => {
    for (const c of COM_ID) expect(isPublicPath(c.replace("[id]", "abc"))).toBe(false);
  });

  it("não libera sub-path /x em nenhum caminho da lista", () => {
    for (const c of [...COM_ID, ...LITERAIS]) expect(isPublicPath(`${c}/x`)).toBe(false);
  });

  it("sources/upload é irmão literal: não entra por sources/[id]", () => {
    expect(isPublicPath("/api/v1/ai/knowledge/sources/upload")).toBe(true);
    expect(isPublicPath("/api/v1/ai/knowledge/sources/abc")).toBe(false);
  });

  it("irmãos só de sessão (chave, provedor) seguem fora", () => {
    expect(isPublicPath("/api/v1/ai/knowledge/chave")).toBe(false);
    expect(isPublicPath("/api/v1/ai/knowledge/provedor")).toBe(false);
  });
});
