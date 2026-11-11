// @vitest-environment node
/**
 * Token de integração nas rotas de produtos e de tags (Spec 33, fatia R1).
 *
 * Métodos convertidos (escopo `config:read` na leitura, `config:write` na escrita,
 * papel `admin` no token):
 *  - GET e POST    /api/v1/products
 *  - PATCH e DELETE /api/v1/products/[id]
 *  - POST e PUT    /api/v1/products/[id]/fotos
 *  - GET e POST    /api/v1/products/import
 *  - GET           /api/v1/tags/cores
 *  - GET           /api/v1/tags/vocabulario
 *
 * Fica só de sessão: POST /api/v1/tags/vocabulario. A função de escrita
 * (`fn_vocabulario_de_tags_operar`) confere o papel por `fn_role_at_least`, que lê
 * `auth.uid()`; com a service role o `auth.uid()` é nulo e a escrita sempre recusa.
 *
 * Por método: token de A alcança o recurso de A; token de B não alcança o de A;
 * token sem o escopo, abaixo do papel e acima do teto recusados; sessão com o mesmo
 * portão. O banco é `criarClienteAdminFalso`, que guarda as linhas das duas
 * organizações e acusa cadeia ou RPC sem a organização do token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, mfaEmDivida } from "@/lib/auth/server";
import type { Role } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaProdutos from "@/app/api/v1/products/route";
import * as rotaProduto from "@/app/api/v1/products/[id]/route";
import * as rotaFotos from "@/app/api/v1/products/[id]/fotos/route";
import * as rotaImportar from "@/app/api/v1/products/import/route";
import * as rotaCores from "@/app/api/v1/tags/cores/route";
import * as rotaVocabulario from "@/app/api/v1/tags/vocabulario/route";

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
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// Sem fotos por URL nos casos: o downloader só é alcançado com `fotos` no corpo.
vi.mock("@/lib/catalogo/fotos-por-url", () => ({ guardarFotosPorUrl: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const PROD_A = "66666666-6666-4666-8666-666666666666";
const PROD_B = "77777777-7777-4777-8777-777777777777";
/** Forma exata que `fotoPertenceAoProduto` aceita: `<org>/<produto>/<uuid v4>.jpg`. */
const FOTO_A = `${ORG_A}/${PROD_A}/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jpg`;

const CAMINHO_PRODUTOS = "/api/v1/products";
const caminhoProduto = (id: string) => `/api/v1/products/${id}`;
const caminhoFotos = (id: string) => `/api/v1/products/${id}/fotos`;
const CAMINHO_IMPORTAR = "/api/v1/products/import";
const CAMINHO_CORES = "/api/v1/tags/cores";
const CAMINHO_VOCABULARIO = "/api/v1/tags/vocabulario";

const LINHA_PRODUTO_A = {
  id: PROD_A,
  organization_id: ORG_A,
  codigo: "P-A",
  nome: "Produto de A",
  descricao: null,
  marca: null,
  categoria: null,
  preco_cents: 1000,
  moeda: "BRL",
  custo_cents: null,
  controla_estoque: true,
  quantidade: 3,
  ativo: true,
  origem: "manual",
  imagem_url: null,
  fotos: [FOTO_A],
  updated_at: "2026-08-01T10:00:00Z",
};
const LINHA_PRODUTO_B = {
  ...LINHA_PRODUTO_A,
  id: PROD_B,
  organization_id: ORG_B,
  codigo: "P-B",
  nome: "Produto de B",
  fotos: [],
};

const ORG_LINHA_A = { id: ORG_A, currency: "BRL", settings: { tags: [{ tag: "Reclamação", cor: "#dc2626" }] } };
const ORG_LINHA_B = { id: ORG_B, currency: "USD", settings: { tags: [{ tag: "Lead quente", cor: "#16a34a" }] } };

const VOCABULARIO_A = {
  tag: "Reclamação",
  uso_em_contatos: 2,
  uso_em_leads: 0,
  uso_em_conversas: 1,
  em_regras: 0,
  cor: "#dc2626",
  descricao: null,
  no_vocabulario: true,
};
const VOCABULARIO_B = { ...VOCABULARIO_A, tag: "Lead quente", cor: "#16a34a" };

/** Linhas das DUAS organizações: o dublê precisa ver as duas para acusar vazamento. */
const LINHAS = {
  organizations: [ORG_LINHA_A, ORG_LINHA_B],
  catalog_products: [LINHA_PRODUTO_A, LINHA_PRODUTO_B],
};

/** RPC do vocabulário: devolve só a organização pedida, como a função real faz por `p_org`. */
const RPCS = {
  fn_vocabulario_de_tags: (args: Record<string, unknown>) => ({
    data: args.p_org === ORG_A ? [VOCABULARIO_A] : [VOCABULARIO_B],
  }),
};

function novoFalso() {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas: LINHAS, rpc: RPCS });
}

let falso: ReturnType<typeof novoFalso>;

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

type Init = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function pedido(metodo: string, caminho: string, token: string | undefined, corpo?: Init["body"]): NextRequest {
  const init: Init = {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: corpo,
  };
  return new NextRequest(`http://localhost${caminho}`, init);
}

function pedidoJson(metodo: string, caminho: string, corpo: unknown, token?: string): NextRequest {
  return pedido(metodo, caminho, token, JSON.stringify(corpo));
}

function formulario(arquivo: File): FormData {
  const form = new FormData();
  form.set("file", arquivo);
  return form;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const CSV_NOVO = "codigo,nome,preco\nP-NOVO,Produto novo,10.00\n";

function paramsDe(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Os quatro casos de recusa que valem para todo método: escopo, papel, teto e
 * sessão. `escopoExigido` é o do método (`config:read` ou `config:write`);
 * `recurso` é o `resource` da `requireRole` que a rota usa hoje.
 */
function casosDeNegacao(cfg: {
  chamar: (token: string | undefined) => Promise<Response>;
  papel: Role;
  escopoExigido: string;
  recurso: string;
}) {
  it("token sem o escopo exigido é recusado (403), sem escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", TODOS_OS_ESCOPOS.filter((e) => e !== cfg.escopoExigido));
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(falso.rpcs).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (tokenRole admin) é recusado (403)", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await cfg.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
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
    expect(requireRole).toHaveBeenCalledWith(cfg.papel, expect.objectContaining({ resource: cfg.recurso }));
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
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
});

// ===========================================================================
// GET /api/v1/products — catálogo (receita A, leitura: config:read)
// ===========================================================================
describe("GET /api/v1/products — catálogo", () => {
  it("token de A alcança o catálogo de A e não o de B", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaProdutos.GET(pedido("GET", CAMINHO_PRODUTOS, TOKEN_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string }> };
    expect(corpo.data.map((p) => p.id)).toEqual([PROD_A]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
  });

  it("token de B lista só o catálogo de B; o produto de A não aparece", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaProdutos.GET(pedido("GET", CAMINHO_PRODUTOS, TOKEN_B));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string }> };
    expect(corpo.data.map((p) => p.id)).toEqual([PROD_B]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("ramo paginado (pagina + busca): token de A recebe só o catálogo de A, com meta", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaProdutos.GET(pedido("GET", `${CAMINHO_PRODUTOS}?pagina=1&busca=Produto`, TOKEN_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number; pagina: number; has_more: boolean };
    };
    expect(corpo.data.map((p) => p.id)).toEqual([PROD_A]);
    expect(corpo.meta).toMatchObject({ total: 1, pagina: 1, has_more: false });
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("ramo paginado (pagina + busca): token de B recebe só o catálogo de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaProdutos.GET(pedido("GET", `${CAMINHO_PRODUTOS}?pagina=1&busca=Produto`, TOKEN_B));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(corpo.data.map((p) => p.id)).toEqual([PROD_B]);
    expect(corpo.meta.total).toBe(1);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaProdutos.GET(pedido("GET", CAMINHO_PRODUTOS, t)),
    papel: "viewer",
    escopoExigido: "config:read",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// POST /api/v1/products — cadastro (receita A, escrita: config:write)
// ===========================================================================
describe("POST /api/v1/products — cadastro de produto", () => {
  const CORPO = { codigo: "P-NOVO", nome: "Produto novo", preco_cents: 1500 };

  it("token de A cadastra na organização de A, com audit de token", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaProdutos.POST(pedidoJson("POST", CAMINHO_PRODUTOS, CORPO, TOKEN_A));
    expect(res.status).toBe(201);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_A, actorUserId: null, actorApiTokenId: TOKEN_A }),
    );
  });

  it("token de B cria a linha em B; a de A não é lida nem alterada", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaProdutos.POST(pedidoJson("POST", CAMINHO_PRODUTOS, CORPO, TOKEN_B));
    expect(res.status).toBe(201);
    const criado = linhasDaTabela(falso, "catalog_products").find((p) => p.codigo === "P-NOVO");
    expect(criado?.organization_id).toBe(ORG_B);
    expect(linhasDaTabela(falso, "catalog_products").find((p) => p.id === PROD_A)).toMatchObject({
      organization_id: ORG_A,
      preco_cents: 1000,
    });
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("corpo inválido com token: 422 (sem nome), nada gravado e sem audit", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaProdutos.POST(pedidoJson("POST", CAMINHO_PRODUTOS, { codigo: "P-X" }, TOKEN_A));
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaProdutos.POST(pedidoJson("POST", CAMINHO_PRODUTOS, CORPO, t)),
    papel: "manager",
    escopoExigido: "config:write",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// PATCH /api/v1/products/[id] (receita A, escrita: config:write)
// ===========================================================================
describe("PATCH /api/v1/products/[id] — preço e dados do produto", () => {
  it("token de A altera o produto de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaProduto.PATCH(
      pedidoJson("PATCH", caminhoProduto(PROD_A), { preco_cents: 2000 }, TOKEN_A),
      paramsDe(PROD_A),
    );
    expect(res.status).toBe(200);
    expect(linhasDaTabela(falso, "catalog_products").find((p) => p.id === PROD_A)?.preco_cents).toBe(2000);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A }));
  });

  it("token de B não alcança o produto de A: 404 e a linha de A fica igual", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaProduto.PATCH(
      pedidoJson("PATCH", caminhoProduto(PROD_A), { preco_cents: 2000 }, TOKEN_B),
      paramsDe(PROD_A),
    );
    expect(res.status).toBe(404);
    expect(linhasDaTabela(falso, "catalog_products").find((p) => p.id === PROD_A)?.preco_cents).toBe(1000);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaProduto.PATCH(pedidoJson("PATCH", caminhoProduto(PROD_A), { preco_cents: 2000 }, t), paramsDe(PROD_A)),
    papel: "manager",
    escopoExigido: "config:write",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// DELETE /api/v1/products/[id] (receita A, escrita: config:write)
// ===========================================================================
describe("DELETE /api/v1/products/[id] — remoção do produto", () => {
  it("token de A remove o produto de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaProduto.DELETE(pedido("DELETE", caminhoProduto(PROD_A), TOKEN_A), paramsDe(PROD_A));
    expect(res.status).toBe(200);
    expect(linhasDaTabela(falso, "catalog_products").some((p) => p.id === PROD_A)).toBe(false);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorApiTokenId: TOKEN_A }));
    // A foto do produto sai do Storage, e só com caminho do prefixo de A.
    const removidos = falso.uploads.filter((u) => u.operacao === "remove").map((u) => u.caminho);
    expect(removidos).toEqual([FOTO_A]);
    expect(removidos.every((c) => c.startsWith(`${ORG_A}/${PROD_A}/`))).toBe(true);
  });

  it("token de B não remove o produto de A: 404 e a linha de A continua", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaProduto.DELETE(pedido("DELETE", caminhoProduto(PROD_A), TOKEN_B), paramsDe(PROD_A));
    expect(res.status).toBe(404);
    expect(linhasDaTabela(falso, "catalog_products").some((p) => p.id === PROD_A)).toBe(true);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaProduto.DELETE(pedido("DELETE", caminhoProduto(PROD_A), t), paramsDe(PROD_A)),
    papel: "manager",
    escopoExigido: "config:write",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// POST /api/v1/products/[id]/fotos (receita A, escrita: config:write)
// ===========================================================================
describe("POST /api/v1/products/[id]/fotos — sobe uma foto", () => {
  const novaFoto = () => formulario(new File([JPEG], "foto.jpg", { type: "image/jpeg" }));

  it("token de A sobe a foto no prefixo de A e grava o caminho no produto de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaFotos.POST(pedido("POST", caminhoFotos(PROD_A), TOKEN_A, novaFoto()), paramsDe(PROD_A));
    expect(res.status).toBe(200);
    expect(falso.uploads.length).toBe(1);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorApiTokenId: TOKEN_A }));
  });

  it("token de B não alcança o produto de A: 404, nada subido, nada gravado", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaFotos.POST(pedido("POST", caminhoFotos(PROD_A), TOKEN_B, novaFoto()), paramsDe(PROD_A));
    expect(res.status).toBe(404);
    expect(falso.uploads).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaFotos.POST(pedido("POST", caminhoFotos(PROD_A), t, novaFoto()), paramsDe(PROD_A)),
    papel: "manager",
    escopoExigido: "config:write",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// PUT /api/v1/products/[id]/fotos (receita A, escrita: config:write)
// ===========================================================================
describe("PUT /api/v1/products/[id]/fotos — reordena e remove fotos", () => {
  it("token de A reordena as fotos do produto de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaFotos.PUT(
      pedidoJson("PUT", caminhoFotos(PROD_A), { fotos: [FOTO_A] }, TOKEN_A),
      paramsDe(PROD_A),
    );
    expect(res.status).toBe(200);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorApiTokenId: TOKEN_A }));
  });

  it("token de B não alcança o produto de A: 404 e nenhuma escrita", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaFotos.PUT(
      pedidoJson("PUT", caminhoFotos(PROD_A), { fotos: [FOTO_A] }, TOKEN_B),
      paramsDe(PROD_A),
    );
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token de A remove foto do produto de A: o Storage recebe só caminhos do prefixo de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaFotos.PUT(pedidoJson("PUT", caminhoFotos(PROD_A), { fotos: [] }, TOKEN_A), paramsDe(PROD_A));
    expect(res.status).toBe(200);
    expect(linhasDaTabela(falso, "catalog_products").find((p) => p.id === PROD_A)?.fotos).toEqual([]);
    const removidos = falso.uploads.filter((u) => u.operacao === "remove").map((u) => u.caminho);
    expect(removidos).toEqual([FOTO_A]);
    expect(removidos.every((c) => c.startsWith(`${ORG_A}/${PROD_A}/`))).toBe(true);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B manda a foto de A no produto de B: 409, nada gravado e nada removido", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaFotos.PUT(
      pedidoJson("PUT", caminhoFotos(PROD_B), { fotos: [FOTO_A] }, TOKEN_B),
      paramsDe(PROD_B),
    );
    expect(res.status).toBe(409);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(falso.uploads).toEqual([]);
    expect(linhasDaTabela(falso, "catalog_products").find((p) => p.id === PROD_B)?.fotos).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaFotos.PUT(pedidoJson("PUT", caminhoFotos(PROD_A), { fotos: [FOTO_A] }, t), paramsDe(PROD_A)),
    papel: "manager",
    escopoExigido: "config:write",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// GET /api/v1/products/import — modelo da planilha (receita A, leitura: config:read)
// ===========================================================================
describe("GET /api/v1/products/import — modelo de planilha", () => {
  // O modelo não tem dado de organização: o caso de B confere só que nada do banco
  // foi lido, e que a resposta é o mesmo modelo para qualquer token.
  it("token de A recebe o modelo, sem ler o banco", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaImportar.GET(pedido("GET", CAMINHO_IMPORTAR, TOKEN_A));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("codigo,nome,marca");
    expect(falso.cadeias).toEqual([]);
  });

  it("token de B recebe o mesmo modelo, sem ler o banco de A", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaImportar.GET(pedido("GET", CAMINHO_IMPORTAR, TOKEN_B));
    expect(res.status).toBe(200);
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaImportar.GET(pedido("GET", CAMINHO_IMPORTAR, t)),
    papel: "manager",
    escopoExigido: "config:read",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// POST /api/v1/products/import — importa a planilha (receita A, escrita: config:write)
// ===========================================================================
describe("POST /api/v1/products/import — importação da planilha", () => {
  const planilha = () => formulario(new File([CSV_NOVO], "catalogo.csv", { type: "text/csv" }));

  it("token de A importa para a organização de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaImportar.POST(pedido("POST", CAMINHO_IMPORTAR, TOKEN_A, planilha()));
    expect(res.status).toBe(200);
    expect(linhasDaTabela(falso, "catalog_products").some((p) => p.codigo === "P-NOVO" && p.organization_id === ORG_A)).toBe(true);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorApiTokenId: TOKEN_A }));
  });

  it("token de B importa para B; o produto de A não é lido nem alterado", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaImportar.POST(pedido("POST", CAMINHO_IMPORTAR, TOKEN_B, planilha()));
    expect(res.status).toBe(200);
    expect(linhasDaTabela(falso, "catalog_products").some((p) => p.codigo === "P-NOVO" && p.organization_id === ORG_B)).toBe(true);
    expect(linhasDaTabela(falso, "catalog_products").find((p) => p.id === PROD_A)).toMatchObject({ preco_cents: 1000 });
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token de B importa o código P-A (de A): cria a linha em B e a de A fica intacta", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const csv = "codigo,nome,preco\nP-A,Produto de B com código de A,10.00\n";
    const res = await rotaImportar.POST(
      pedido("POST", CAMINHO_IMPORTAR, TOKEN_B, formulario(new File([csv], "catalogo.csv", { type: "text/csv" }))),
    );
    expect(res.status).toBe(200);
    const linhasComCodigo = linhasDaTabela(falso, "catalog_products").filter((p) => p.codigo === "P-A");
    expect(linhasComCodigo.map((p) => p.organization_id).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(linhasDaTabela(falso, "catalog_products").find((p) => p.id === PROD_A)).toMatchObject({
      organization_id: ORG_A,
      nome: "Produto de A",
      preco_cents: 1000,
    });
    // Nenhuma escrita da importação de B sai da organização de B.
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("token com foto por URL na planilha: 422 foto_por_url_so_na_sessao, nada baixado nem gravado", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const csv = "codigo,nome,preco,foto\nP-NOVO,Produto novo,10.00,https://exemplo.com/foto.jpg\n";
    const res = await rotaImportar.POST(
      pedido("POST", CAMINHO_IMPORTAR, TOKEN_A, formulario(new File([csv], "catalogo.csv", { type: "text/csv" }))),
    );
    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; details: { linhas: number[] } } };
    expect(corpo.error.code).toBe("foto_por_url_so_na_sessao");
    expect(corpo.error.details.linhas).toEqual([2]);
    expect(guardarFotosPorUrl).not.toHaveBeenCalled();
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(falso.uploads).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  casosDeNegacao({
    chamar: (t) => rotaImportar.POST(pedido("POST", CAMINHO_IMPORTAR, t, planilha())),
    papel: "manager",
    escopoExigido: "config:write",
    recurso: "catalog_products",
  });
});

// ===========================================================================
// GET /api/v1/tags/cores (receita A, leitura: config:read)
// ===========================================================================
describe("GET /api/v1/tags/cores — cores das etiquetas", () => {
  it("token de A recebe só as etiquetas de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaCores.GET(pedido("GET", CAMINHO_CORES, TOKEN_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ tag: string }> };
    expect(corpo.data.map((e) => e.tag)).toEqual(["Reclamação"]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("token de B não recebe as etiquetas de A", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaCores.GET(pedido("GET", CAMINHO_CORES, TOKEN_B));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ tag: string }> };
    expect(corpo.data.map((e) => e.tag)).toEqual(["Lead quente"]);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaCores.GET(pedido("GET", CAMINHO_CORES, t)),
    papel: "viewer",
    escopoExigido: "config:read",
    recurso: "settings_tags",
  });
});

// ===========================================================================
// GET /api/v1/tags/vocabulario (receita A, leitura: config:read)
// ===========================================================================
describe("GET /api/v1/tags/vocabulario — vocabulário de etiquetas", () => {
  it("token de A recebe o vocabulário de A e não consulta o MFA da sessão", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaVocabulario.GET(pedido("GET", CAMINHO_VOCABULARIO, TOKEN_A));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ tag: string }> };
    expect(corpo.data.map((e) => e.tag)).toEqual(["Reclamação"]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(mfaEmDivida).not.toHaveBeenCalled();
  });

  it("token de B recebe só o vocabulário de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaVocabulario.GET(pedido("GET", CAMINHO_VOCABULARIO, TOKEN_B));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ tag: string }> };
    expect(corpo.data.map((e) => e.tag)).toEqual(["Lead quente"]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
  });

  casosDeNegacao({
    chamar: (t) => rotaVocabulario.GET(pedido("GET", CAMINHO_VOCABULARIO, t)),
    papel: "manager",
    escopoExigido: "config:read",
    recurso: "settings_tags",
  });
});

// ===========================================================================
// POST /api/v1/tags/vocabulario — FICA SÓ DE SESSÃO (um caso a mais)
// ===========================================================================
describe("POST /api/v1/tags/vocabulario: fica só de sessão", () => {
  it("com token e sem cookie: 401 do requireRole, e o cliente admin nunca é usado", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    const res = await rotaVocabulario.POST(
      pedidoJson("POST", CAMINHO_VOCABULARIO, { acao: "renomear", tag: "Reclamação", destino: "Queixa" }, TOKEN_A),
    );
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "settings_tags" }));
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Bloco de borda: cada porta nova, e os irmãos literais que não ganharam porta
// ===========================================================================
const UUID_DE_TESTE = PROD_A;

describe("borda das portas de produtos e tags (isPublicPath)", () => {
  it.each([
    ["/api/v1/products", true],
    ["/api/v1/products/import", true],
    ["/api/v1/products/import/x", false],
    ["/api/v1/products/importar", false],
    [`/api/v1/products/${UUID_DE_TESTE}`, true],
    ["/api/v1/products/abc", false],
    [`/api/v1/products/${UUID_DE_TESTE}/x`, false],
    [`/api/v1/products/${UUID_DE_TESTE}/fotos`, true],
    [`/api/v1/products/abc/fotos`, false],
    [`/api/v1/products/${UUID_DE_TESTE}/fotos/x`, false],
    [`/api/v1/products/${UUID_DE_TESTE}/foto`, false],
    ["/api/v1/tags/cores", true],
    ["/api/v1/tags/cores/x", false],
    ["/api/v1/tags/vocabulario", true],
    ["/api/v1/tags/vocabulario/x", false],
    ["/api/v1/tags", false],
  ])("%s → %s", (caminho, esperado) => {
    expect(isPublicPath(caminho)).toBe(esperado);
  });
});
