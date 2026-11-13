// @vitest-environment node
/**
 * POST /api/v1/agenda/servicos/atualizar — token de integração (Spec 33, R0).
 *
 * Esta rota não consulta tabela: o que isola as organizações é a organização
 * da LINHA DO TOKEN entrar em toda chamada, `p_org` em cada RPC e o segundo
 * argumento de `atualizarFontesDoServico`. A função SQL
 * `fn_calendar_service_sources_to_refresh` filtra por `k.organization_id =
 * p_org` (baseline.sql), mas nenhum teste de banco a exercita hoje com a
 * organização de outro tenant: isso NÃO é medido aqui. Aqui se prova o que a
 * rota controla: o token de B nunca faz a organização A aparecer em chamada
 * nenhuma, e a organização do corpo é recusada.
 *
 * `atualizarFontesDoServico` faz rede (sincroniza o calendário do Google,
 * quando há fonte), então é a ÚNICA função trocada por um mock; as RPCs
 * `fn_calendar_service_*` passam pelo cliente falso por organização
 * (`tests/unit/helpers/cliente-admin-falso.ts`).
 *
 * Os mocks fazem o ramo do token falhar alto se ele tocar na sessão:
 * `createClient` e `loadAuthUser` lançam. Só o teste da sessão troca isso.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { atualizarFontesDoServico } from "@/lib/agenda/servicos/consulta";
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
// Só esta função faz rede (sincronização do Google). As RPCs da rota NÃO são trocadas.
vi.mock("@/lib/agenda/servicos/consulta", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agenda/servicos/consulta")>(
    "@/lib/agenda/servicos/consulta",
  );
  return { ...actual, atualizarFontesDoServico: vi.fn() };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "a0a0a0a0-0000-4000-8000-0000000000a1";
const TOKEN_B = "b0b0b0b0-0000-4000-8000-0000000000b1";
const USER_ID = "11111111-1111-4111-8111-111111111111";
/** O serviço (tipo de evento) é da organização A. */
const SERVICO_DE_A = "e1e1e1e1-1111-4111-8111-e1e1e1e1e1e1";

const CAMINHO = "/api/v1/agenda/servicos/atualizar";

/** Nenhuma tabela: esta rota só fala com o banco por RPC. */
const TABELAS_SEM_ORGANIZACAO: readonly string[] = [];

// O valor do cabeçalho é montado em runtime: o literal com o prefixo e o valor
// juntos não precisa existir no arquivo para provar o CAMINHO.
const COMO_A = { authorization: ["Bearer", "dsk_teste_a"].join(" ") };
const COMO_B = { authorization: ["Bearer", "dsk_teste_b"].join(" ") };

type Falso = ReturnType<typeof criarClienteAdminFalso>;

let falso: Falso;

function montarFalso(): Falso {
  return criarClienteAdminFalso({
    orgDona: ORG_A,
    // `fn_calendar_service_assert_actor` devolve void: o cliente falso a resolve com data nulo.
    rpc: { fn_calendar_service_assert_actor: null },
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

function chamar(corpo: unknown, cabecalhos: Record<string, string> = {}): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost${CAMINHO}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cabecalhos },
      body: JSON.stringify(corpo),
    }),
  );
}

type Corpo = { data?: { complete?: boolean; calendars?: number }; error?: { code?: string } };

async function jsonDe(res: Response): Promise<Corpo> {
  return (await res.json()) as Corpo;
}

/** As RPCs `fn_calendar_service_assert_actor` que o cliente falso registrou. */
function rpcsDeAssertActor(banco: Falso) {
  return banco.rpcs.filter((rpc) => rpc.nome === "fn_calendar_service_assert_actor");
}

/** As organizações que `atualizarFontesDoServico` recebeu (segundo argumento). */
function organizacoesRecebidas(): unknown[] {
  return vi.mocked(atualizarFontesDoServico).mock.calls.map((chamada) => chamada[1]);
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
  // Modela `fn_calendar_service_sources_to_refresh` (`where k.organization_id = p_org`): as 2 fontes
  // do serviço são de A, e quem pede em nome de outra organização encontra zero.
  vi.mocked(atualizarFontesDoServico).mockReset();
  vi.mocked(atualizarFontesDoServico).mockImplementation(async (_db, organizationId) => ({
    complete: true,
    calendars: organizationId === ORG_A ? 2 : 0,
  }));
});

describe("POST /api/v1/agenda/servicos/atualizar — token de integração", () => {
  it("token de A alcança o recurso de A: confere o ator por RPC com a organização de A e atualiza as fontes de A", async () => {
    tokenDe(ORG_A, TOKEN_A);
    const res = await chamar({ event_type_id: SERVICO_DE_A }, COMO_A);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { complete: true, calendars: 2 } });
    // O token não é recusado pelo guarda de acompanhamento de suporte: ele roda e devolve null.
    expect(requireSupportWrite).toHaveBeenCalledTimes(1);

    // A RPC de ator passou pelo cliente falso, com a organização e o ator da linha do token.
    const assertores = rpcsDeAssertActor(falso);
    expect(assertores).toHaveLength(1);
    expect(assertores[0]?.args).toEqual({
      p_org: ORG_A,
      p_actor: { type: "api_token", id: TOKEN_A, role: "agent" },
      p_role: "agent",
    });

    // `atualizarFontesDoServico` recebeu o cliente admin, a organização do token e o serviço do corpo.
    expect(atualizarFontesDoServico).toHaveBeenCalledTimes(1);
    const chamada = vi.mocked(atualizarFontesDoServico).mock.calls[0];
    expect(Object.is(chamada?.[0], falso.cliente)).toBe(true);
    expect(chamada?.[1]).toBe(ORG_A);
    expect(chamada?.[2]).toBe(SERVICO_DE_A);

    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(
      cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO }),
    ).toEqual([]);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.service_refresh",
        actorUserId: null,
        actorApiTokenId: TOKEN_A,
        organizationId: ORG_A,
        metadata: { complete: true },
      }),
    );
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("token de B não alcança o recurso de A: nenhuma chamada leva a organização A, e as fontes de A não aparecem", async () => {
    tokenDe(ORG_B, TOKEN_B);
    // O serviço pedido é o de A; o token é de B.
    const res = await chamar({ event_type_id: SERVICO_DE_A }, COMO_B);

    // Não há consulta de tabela para devolver 404: a função do banco filtra por `p_org` e a
    // rota responde 200 com zero fontes. O que a rota controla é a organização que ela envia.
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { complete: true, calendars: 0 } });

    const assertores = rpcsDeAssertActor(falso);
    expect(assertores).toHaveLength(1);
    expect(assertores[0]?.args.p_org).toBe(ORG_B);
    expect(assertores[0]?.args.p_actor).toEqual({ type: "api_token", id: TOKEN_B, role: "agent" });
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);

    // Toda organização que chegou à função de atualização é a de B; a de A nunca.
    expect(organizacoesRecebidas()).toEqual([ORG_B]);
    expect(organizacoesRecebidas()).not.toContain(ORG_A);

    // Sem tabelas: nenhuma cadeia, e portanto nenhuma escrita.
    expect(falso.cadeias).toEqual([]);
    // A rota audita toda atualização concluída; o registro desta fica dentro de B.
    expect(vi.mocked(audit).mock.calls.every(([entrada]) => entrada.organizationId === ORG_B)).toBe(true);
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
  });

  it("a organização no corpo é recusada com 422: nunca vale", async () => {
    tokenDe(ORG_B, TOKEN_B);
    const res = await chamar({ event_type_id: SERVICO_DE_A, organization_id: ORG_A }, COMO_B);

    expect(res.status).toBe(422);
    expect((await jsonDe(res)).error?.code).toBe("validation_failed");
    expect(falso.rpcs).toEqual([]);
    expect(atualizarFontesDoServico).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("token sem mcp:write é recusado com 403, sem RPC nem atualização", async () => {
    tokenDe(ORG_A, TOKEN_A, { scopes: ["mcp:read"] });
    const res = await chamar({ event_type_id: SERVICO_DE_A }, COMO_A);

    expect(res.status).toBe(403);
    expect((await jsonDe(res)).error?.code).toBe("forbidden_role");
    expect(falso.rpcs).toEqual([]);
    expect(falso.cadeias).toEqual([]);
    expect(atualizarFontesDoServico).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("token viewer é recusado com 403, sem RPC nem atualização", async () => {
    tokenDe(ORG_A, TOKEN_A, { role: "viewer" });
    const res = await chamar({ event_type_id: SERVICO_DE_A }, COMO_A);

    expect(res.status).toBe(403);
    expect((await jsonDe(res)).error?.code).toBe("forbidden_role");
    expect(falso.rpcs).toEqual([]);
    expect(atualizarFontesDoServico).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem RPC nem consulta", async () => {
    tokenDe(ORG_A, TOKEN_A);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30, window_sec: 60 });
    const res = await chamar({ event_type_id: SERVICO_DE_A }, COMO_A);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(vi.mocked(checkRateLimit).mock.calls[0]?.[0]).toBe(`agenda:tok:${TOKEN_A}`);
    expect(falso.cadeias).toEqual([]);
    expect(falso.rpcs).toEqual([]);
    expect(atualizarFontesDoServico).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/agenda/servicos/atualizar — sessão de navegador", () => {
  it("sessão continua com o mesmo portão: requireRole agent, a pessoa como ator e sem teto", async () => {
    const sessao = criarClienteAdminFalso({ orgDona: ORG_A, tabelasSemOrganizacao: TABELAS_SEM_ORGANIZACAO });
    vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER_ID, idioma: "pt-BR" },
      org: { orgId: ORG_A, name: "Org", role: "agent" },
    } as never);

    const res = await chamar({ event_type_id: SERVICO_DE_A });

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await jsonDe(res)).toEqual({ data: { complete: true, calendars: 2 } });

    expect(requireRole).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "agenda" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();

    // A organização vem da sessão e o ator é a pessoa; as RPCs seguem pelo cliente admin.
    //
    // O ator carrega `role` desde a #4517 (`resolveAuthDual`), porque há handler
    // que decide por hierarquia (#3436) e a regra tem de ver o papel no MESMO
    // lugar em que o token o carrega. O payload do RPC ganhou a chave de carona;
    // `fn_calendar_service_assert_actor` lê `type`/`id`/`api_token_id` e ignora
    // o resto — medido na migration 0716.
    const assertores = rpcsDeAssertActor(falso);
    expect(assertores).toHaveLength(1);
    expect(assertores[0]?.args).toEqual({
      p_org: ORG_A,
      p_actor: { type: "user", id: USER_ID, role: "agent" },
      p_role: "agent",
    });
    expect(organizacoesRecebidas()).toEqual([ORG_A]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.service_refresh",
        actorUserId: USER_ID,
        actorApiTokenId: null,
        organizationId: ORG_A,
      }),
    );
  });
});
