// @vitest-environment node
/**
 * POST /api/v1/conversations/[id]/notes/media — token de integração (Spec 33, R0).
 *
 * No ramo do token o cliente é a service role, que contorna a RLS: o que isola
 * as organizações é o `.eq("organization_id", …)` da consulta da conversa e o
 * prefixo `{org}/{conversa}/` do caminho no bucket `internal-media`. O banco e
 * o storage aqui são o cliente falso por organização
 * (`tests/unit/helpers/cliente-admin-falso.ts`): a conversa de A e a de B moram
 * na MESMA tabela, e uma consulta sem o filtro da organização não alcança nenhuma.
 *
 * Os mocks fazem o ramo do token falhar alto se ele tocar na sessão:
 * `createClient` e `loadAuthUser` lançam. Só o teste da sessão troca isso.
 *
 * Multipart pede ambiente `node` (a linha 1): sob jsdom o `File` global não é
 * o que o corpo da requisição devolve, e `file instanceof File` falharia.
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
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
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

/** Nenhuma: `conversations` tem `organization_id` (baseline.sql). */
const TABELAS_SEM_ORGANIZACAO: readonly string[] = [];

// O valor do cabeçalho é montado em runtime: o literal com o prefixo e o valor
// juntos não precisa existir no arquivo para provar o CAMINHO.
const COMO_A = { authorization: ["Bearer", "dsk_teste_a"].join(" ") };
const COMO_B = { authorization: ["Bearer", "dsk_teste_b"].join(" ") };

type Falso = ReturnType<typeof criarClienteAdminFalso>;

let falso: Falso;

/** Uma conversa de A e uma de B, na mesma tabela. */
function montarFalso(): Falso {
  return criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: {
      conversations: [
        { id: CONV_A, organization_id: ORG_A },
        { id: CONV_B, organization_id: ORG_B },
      ],
    },
    tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO,
  });
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

/** Um PNG mínimo: a rota só confere o tipo declarado e o tamanho, não a assinatura dos bytes. */
function arquivoPng(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
}

function chamar(conversa: string, cabecalhos: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  form.set("file", arquivoPng());
  const req = new NextRequest(`http://localhost/api/v1/conversations/${conversa}/notes/media`, {
    method: "POST",
    headers: cabecalhos,
    body: form,
  });
  return POST(req, { params: Promise.resolve({ id: conversa }) });
}

type Corpo = {
  data?: { storage_path?: string; media_mime?: string; media_size_bytes?: number; kind?: string };
  error?: { code?: string };
};

async function jsonDe(res: Response): Promise<Corpo> {
  return (await res.json()) as Corpo;
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

describe("POST /api/v1/conversations/[id]/notes/media — token de integração", () => {
  it("token de A alcança o recurso de A: lê a conversa de A com o filtro da organização e sobe o arquivo em internal-media sob a organização de A", async () => {
    tokenDe(ORG_A, TOKEN_A);
    const res = await chamar(CONV_A, COMO_A);

    expect(res.status, await res.clone().text()).toBe(200);
    const corpo = await jsonDe(res);
    expect(corpo.data).toMatchObject({ media_mime: "image/png", media_size_bytes: 4, kind: "image" });
    expect(corpo.data?.storage_path).toMatch(new RegExp(`^${ORG_A}/${CONV_A}/note-[0-9a-f-]{36}\\.png$`));
    // O token não é recusado pelo guarda de acompanhamento de suporte: ele roda e devolve null.
    expect(requireSupportWrite).toHaveBeenCalledTimes(1);

    // Um único upload, no bucket das notas (e não no do canal do cliente), debaixo da organização de A.
    expect(falso.uploads).toHaveLength(1);
    expect(falso.uploads[0]).toMatchObject({ bucket: "internal-media", operacao: "upload" });
    expect(falso.uploads[0]?.caminho.startsWith(`${ORG_A}/`)).toBe(true);
    expect(falso.uploads[0]?.caminho).toBe(corpo.data?.storage_path);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);

    // Uma única consulta: a conversa, filtrada pelo id do path E pela organização do token.
    expect(falso.cadeias).toHaveLength(1);
    expect(falso.cadeias[0]).toMatchObject({ tabela: "conversations", operacao: "select" });
    expect(falso.cadeias[0]?.filtros).toContainEqual(["id", CONV_A]);
    expect(falso.cadeias[0]?.filtros).toContainEqual(["organization_id", ORG_A]);
    expect(
      cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    // Nenhuma linha de tabela é gravada: o anexo só vai para o bucket.
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("token de B não alcança o recurso de A: 404 not_found, nada sobe e nenhuma escrita acontece", async () => {
    tokenDe(ORG_B, TOKEN_B);
    const res = await chamar(CONV_A, COMO_B);

    expect(res.status, await res.clone().text()).toBe(404);
    expect((await jsonDe(res)).error?.code).toBe("not_found");

    // A rota para na consulta da conversa: ela roda com o filtro de B e não casa a linha de A.
    expect(falso.cadeias).toHaveLength(1);
    expect(falso.cadeias[0]?.filtros).toContainEqual(["organization_id", ORG_B]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(
      cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
    expect(falso.uploads).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("controle: o mesmo token de B alcança a conversa de B, e o arquivo sobe sob a organização de B", async () => {
    tokenDe(ORG_B, TOKEN_B);
    const res = await chamar(CONV_B, COMO_B);

    expect(res.status, await res.clone().text()).toBe(200);
    const corpo = await jsonDe(res);
    expect(corpo.data?.storage_path?.startsWith(`${ORG_B}/${CONV_B}/note-`)).toBe(true);
    expect(falso.uploads).toHaveLength(1);
    expect(falso.uploads[0]).toMatchObject({ bucket: "internal-media" });
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
    expect(falso.uploads[0]?.caminho.includes(ORG_A)).toBe(false);
  });

  it("token sem mcp:write é recusado com 403, sem consulta nem upload", async () => {
    tokenDe(ORG_A, TOKEN_A, { scopes: ["mcp:read"] });
    const res = await chamar(CONV_A, COMO_A);

    expect(res.status).toBe(403);
    expect((await jsonDe(res)).error?.code).toBe("forbidden_role");
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toEqual([]);
  });

  it("token viewer é recusado com 403, sem consulta nem upload", async () => {
    tokenDe(ORG_A, TOKEN_A, { role: "viewer" });
    const res = await chamar(CONV_A, COMO_A);

    expect(res.status).toBe(403);
    expect((await jsonDe(res)).error?.code).toBe("forbidden_role");
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toEqual([]);
  });

  it("acima do teto do token → 429 com Retry-After, sem consulta nem upload", async () => {
    tokenDe(ORG_A, TOKEN_A);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30, window_sec: 60 });
    const res = await chamar(CONV_A, COMO_A);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`conversation_notes:tok:${TOKEN_A}`);
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toEqual([]);
  });
});

describe("POST /api/v1/conversations/[id]/notes/media — sessão de navegador", () => {
  it("sessão continua com o mesmo portão: requireRole agent, a conversa lida pelo cliente da sessão e sem teto", async () => {
    const sessao = criarClienteAdminFalso({
      orgDona: ORG_A,
      linhas: { conversations: [{ id: CONV_A, organization_id: ORG_A }] },
      tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO,
    });
    vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A, name: "Org", role: "agent" },
    } as never);

    const res = await chamar(CONV_A);

    expect(res.status, await res.clone().text()).toBe(200);

    expect(requireRole).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "conversation_notes" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();

    // A conversa foi lida pelo cliente da SESSÃO, com o filtro da organização.
    expect(sessao.cadeias).toHaveLength(1);
    expect(sessao.cadeias[0]?.filtros).toContainEqual(["organization_id", ORG_A]);
    expect(
      cadeiasForaDaOrganizacao(sessao.cadeias, ORG_A, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    // O arquivo sobe pelo cliente admin, sob a organização da sessão; o admin não consultou tabela.
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toHaveLength(1);
    expect(falso.uploads[0]).toMatchObject({ bucket: "internal-media", operacao: "upload" });
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
  });
});
