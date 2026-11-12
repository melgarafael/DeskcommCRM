// @vitest-environment node
/**
 * POST /api/v1/conversations/[id]/drafts/consume — token de integração
 * (Spec 33, R0).
 *
 * No ramo do token o cliente é a service role, que contorna a RLS: o que isola
 * as organizações é o `.eq("organization_id", …)` que `consumirRascunho` escreve
 * à mão. O banco aqui é o cliente falso por organização
 * (`tests/unit/helpers/cliente-admin-falso.ts`): a linha de A e a de B moram na
 * MESMA tabela, e um UPDATE sem o filtro da organização não alcança nenhuma.
 *
 * Os mocks fazem o ramo do token falhar alto se ele tocar na sessão:
 * `createClient` e `loadAuthUser` lançam. Só o teste da sessão troca isso.
 *
 * Tabela e colunas conferidas em `supabase/baseline.sql`: `conversation_drafts`
 * tem `organization_id`, `conversation_id`, `expires_at`, `consumed_at` e
 * `consumed_by_user_id` (este nulo, FK para `auth.users`): a rota só escreve
 * nela, e só por `consumirRascunho` (`lib/inbox/rascunho-sugerido.ts`).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
  arquivosForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import { POST } from "./route";

const { SESSAO_NO_TOKEN } = vi.hoisted(() => ({
  SESSAO_NO_TOKEN: "cliente de sessão usado no ramo do token",
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error(SESSAO_NO_TOKEN);
  }),
}));
vi.mock("@/lib/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/server")>("@/lib/auth/server");
  return {
    ...actual,
    loadAuthUser: () => {
      throw new Error(SESSAO_NO_TOKEN);
    },
  };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "a0a0a0a0-0000-4000-8000-0000000000a1";
const TOKEN_B = "b0b0b0b0-0000-4000-8000-0000000000b1";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONV_A = "c1c1c1c1-1111-4111-8111-c1c1c1c1c1c1";
const CONV_B = "c2c2c2c2-2222-4222-8222-c2c2c2c2c2c2";
const OUTRA_CONV_DE_A = "f1f1f1f1-1111-4111-8111-f1f1f1f1f1f1";
const DRAFT_A = "d1d1d1d1-1111-4111-8111-d1d1d1d1d1d1";
const DRAFT_B = "d2d2d2d2-2222-4222-8222-d2d2d2d2d2d2";

/** Nenhuma: a única tabela desta rota (`conversation_drafts`) tem `organization_id` (baseline.sql). */
const TABELAS_SEM_ORGANIZACAO: readonly string[] = [];

// O valor do cabeçalho é montado em runtime: o literal com o prefixo e o valor
// juntos não precisa existir no arquivo para provar o CAMINHO.
const COMO_A = { authorization: ["Bearer", "dsk_teste_a"].join(" ") };
const COMO_B = { authorization: ["Bearer", "dsk_teste_b"].join(" ") };

type Falso = ReturnType<typeof criarClienteAdminFalso>;

let falso: Falso;

function rascunho(id: string, organizationId: string, conversationId: string): Record<string, unknown> {
  return {
    id,
    organization_id: organizationId,
    conversation_id: conversationId,
    body: "texto sugerido",
    source: "erp",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    consumed_at: null,
    consumed_by_user_id: null,
  };
}

/** Um rascunho de A e um de B, na mesma tabela. */
function montarFalso(): Falso {
  return criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: {
      conversation_drafts: [rascunho(DRAFT_A, ORG_A, CONV_A), rascunho(DRAFT_B, ORG_B, CONV_B)],
    },
    tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO,
  });
}

function linhaDe(banco: Falso, id: string): Record<string, unknown> | undefined {
  return banco.linhas.conversation_drafts?.find((linha) => linha.id === id);
}

function tokenDe(
  organizationId: string,
  tokenId: string,
  opcoes: { role?: Role; scopes?: string[] } = {},
): void {
  const role = opcoes.role ?? "agent";
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId,
    role,
    actor: { type: "api_token", id: tokenId, role },
    apiTokenId: tokenId,
    scopes: opcoes.scopes ?? ["mcp:write"],
  });
}

function chamar(
  corpo: unknown,
  conversa: string,
  cabecalhos: Record<string, string> = {},
): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/conversations/${conversa}/drafts/consume`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cabecalhos },
    body: JSON.stringify(corpo),
  });
  return POST(req, { params: Promise.resolve({ id: conversa }) });
}

async function jsonDe(res: Response): Promise<{ data?: { consumido?: boolean }; error?: { code?: string } }> {
  return (await res.json()) as { data?: { consumido?: boolean }; error?: { code?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  falso = montarFalso();
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(createClient).mockImplementation(() => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(checkRateLimit).mockReset();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30, window_sec: 60 });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockReset();
  vi.mocked(validateBearerToken).mockReset();
});

describe("POST /api/v1/conversations/[id]/drafts/consume — token de integração", () => {
  it("token de A alcança o recurso de A: consome o rascunho de A, sem autor de sessão, e só ele", async () => {
    tokenDe(ORG_A, TOKEN_A);
    const res = await chamar({ draft_id: DRAFT_A }, CONV_A, COMO_A);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { consumido: true } });
    // O token não é recusado pelo guarda de acompanhamento de suporte: ele roda e devolve null.
    expect(requireSupportWrite).toHaveBeenCalledTimes(1);

    expect(
      cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);

    const escritas = cadeiasDeEscrita(falso.cadeias);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]).toMatchObject({ tabela: "conversation_drafts", operacao: "update" });
    expect(escritas[0]?.filtros).toContainEqual(["organization_id", ORG_A]);
    expect(escritas[0]?.filtros).toContainEqual(["id", DRAFT_A]);

    // O rascunho de A ficou consumido e o consumo NÃO tem autor de sessão: o id do token não vai para uma coluna de pessoa.
    const dele = linhaDe(falso, DRAFT_A);
    expect(typeof dele?.consumed_at).toBe("string");
    expect(dele?.consumed_by_user_id).toBeNull();
    // O de B não foi tocado.
    expect(linhaDe(falso, DRAFT_B)).toMatchObject({ consumed_at: null, consumed_by_user_id: null });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.draft_used",
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
        organizationId: ORG_A,
        resourceId: CONV_A,
      }),
    );
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("token de B não alcança o recurso de A: consumido false, o rascunho de A continua intacto e nada é auditado", async () => {
    tokenDe(ORG_B, TOKEN_B);
    const res = await chamar({ draft_id: DRAFT_A }, CONV_A, COMO_B);

    // Rascunho que não é da organização do token não é erro: é `consumido: false`, como o de um rascunho vencido.
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { consumido: false } });

    // A rota SEMPRE tenta o UPDATE (é o consumo). Para o token de B ele roda com o
    // filtro de B e não casa linha alguma: a única escrita registrada é a de B.
    const escritas = cadeiasDeEscrita(falso.cadeias);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.filtros).toContainEqual(["organization_id", ORG_B]);
    expect(
      cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);

    expect(linhaDe(falso, DRAFT_A)).toMatchObject({ consumed_at: null, consumed_by_user_id: null });
    expect(linhaDe(falso, DRAFT_B)).toMatchObject({ consumed_at: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it("controle: o mesmo token de B alcança o rascunho de B, e o de A segue intacto", async () => {
    tokenDe(ORG_B, TOKEN_B);
    const res = await chamar({ draft_id: DRAFT_B }, CONV_B, COMO_B);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { consumido: true } });
    expect(typeof linhaDe(falso, DRAFT_B)?.consumed_at).toBe("string");
    expect(linhaDe(falso, DRAFT_A)).toMatchObject({ consumed_at: null });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_B, actorApiTokenId: TOKEN_B, actorUserId: null }),
    );
  });

  it("rascunho de outra conversa da mesma organização não é consumido", async () => {
    tokenDe(ORG_A, TOKEN_A);
    const res = await chamar({ draft_id: DRAFT_A }, OUTRA_CONV_DE_A, COMO_A);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { consumido: false } });
    expect(linhaDe(falso, DRAFT_A)).toMatchObject({ consumed_at: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it("a organização no corpo é ignorada: vale a da linha do token", async () => {
    tokenDe(ORG_B, TOKEN_B);
    const res = await chamar({ draft_id: DRAFT_A, organization_id: ORG_A }, CONV_A, COMO_B);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { consumido: false } });
    expect(
      cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    expect(linhaDe(falso, DRAFT_A)).toMatchObject({ consumed_at: null });
  });

  it("token sem mcp:write é recusado com 403, sem tocar no banco", async () => {
    tokenDe(ORG_A, TOKEN_A, { scopes: ["mcp:read"] });
    const res = await chamar({ draft_id: DRAFT_A }, CONV_A, COMO_A);

    expect(res.status).toBe(403);
    expect((await jsonDe(res)).error?.code).toBe("forbidden_role");
    expect(falso.cadeias).toEqual([]);
    expect(falso.rpcs).toEqual([]);
    expect(linhaDe(falso, DRAFT_A)).toMatchObject({ consumed_at: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it("token viewer é recusado com 403, sem tocar no banco", async () => {
    tokenDe(ORG_A, TOKEN_A, { role: "viewer" });
    const res = await chamar({ draft_id: DRAFT_A }, CONV_A, COMO_A);

    expect(res.status).toBe(403);
    expect((await jsonDe(res)).error?.code).toBe("forbidden_role");
    expect(falso.cadeias).toEqual([]);
    expect(linhaDe(falso, DRAFT_A)).toMatchObject({ consumed_at: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem nenhuma consulta", async () => {
    tokenDe(ORG_A, TOKEN_A);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30, window_sec: 60 });
    const res = await chamar({ draft_id: DRAFT_A }, CONV_A, COMO_A);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`drafts.consume:tok:${TOKEN_A}`);
    expect(falso.cadeias).toEqual([]);
    expect(linhaDe(falso, DRAFT_A)).toMatchObject({ consumed_at: null });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/conversations/[id]/drafts/consume — sessão de navegador", () => {
  it("sessão continua com o mesmo portão: requireRole agent, o cliente da sessão, o usuário como autor e sem teto", async () => {
    const sessao = criarClienteAdminFalso({
      orgDona: ORG_A,
      linhas: { conversation_drafts: [rascunho(DRAFT_A, ORG_A, CONV_A)] },
      tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO,
    });
    vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A, name: "Org", role: "agent" },
    } as never);

    const res = await chamar({ draft_id: DRAFT_A }, CONV_A);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { consumido: true } });

    expect(requireRole).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "conversations" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();

    // A gravação foi no cliente da SESSÃO, com a pessoa como autora; o admin não foi tocado.
    const dele = sessao.linhas.conversation_drafts?.find((linha) => linha.id === DRAFT_A);
    expect(typeof dele?.consumed_at).toBe("string");
    expect(dele?.consumed_by_user_id).toBe(USER_ID);
    expect(
      cadeiasForaDaOrganizacao(sessao.cadeias, ORG_A, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    expect(falso.cadeias).toEqual([]);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.draft_used",
        actorUserId: USER_ID,
        actorApiTokenId: null,
        organizationId: ORG_A,
      }),
    );
  });
});
