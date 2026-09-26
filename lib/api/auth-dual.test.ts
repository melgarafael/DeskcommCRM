/**
 * `resolveAuthDual` — sessão de navegador OU token de servidor.
 *
 * O que esta suíte prova, e é o que não pode regredir:
 *
 *  1. No ramo do token, `organization_id` sai da LINHA DO TOKEN. Nunca do
 *     corpo, nunca da query. É o que impede um Bearer de uma org escrever
 *     noutra.
 *  2. Escrita exige `mcp:write`. Um token de leitura (`mcp:read`) é recusado
 *     com 403, não aceito com poderes a mais.
 *  3. Sem header `Authorization`, cai na sessão, com o mesmo gate do resto de
 *     `/api/v1/*`.
 *  4. Os caminhos novos estão em `public-paths`. Sem isso o proxy responde 401
 *     antes de qualquer uma das regras acima ser consultada, e a rota fica
 *     inalcançável por token mesmo estando correta.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { McpAuthError } from "@/lib/mcp/auth";

import { resolveAuthDual } from "./auth-dual";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ session: true })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_DO_TOKEN = "22222222-2222-4222-8222-222222222222";
const ORG_DA_SESSAO = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const OPCOES = {
  requestId: "req-1",
  resource: "messages",
  role: "agent" as const,
  scope: "mcp:write",
};

function req(headers?: HeadersInit) {
  return new NextRequest("http://localhost/api/v1/messages", { method: "POST", headers });
}

function sessaoOk(): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [
      { organization_id: ORG_DA_SESSAO, organization_name: "Org", role: "agent" },
    ],
  } as AuthUser;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_DA_SESSAO, role: "agent" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAuthDual", () => {
  it("no ramo do token, a org vem do token e não do corpo", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG_DO_TOKEN,
      scopes: ["mcp:read", "mcp:write"],
      role: "agent",
      actor: { type: "api_token", id: "tok-1" },
    } as never);

    const r = await resolveAuthDual(req({ authorization: "Bearer dsk_abc" }), OPCOES);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.organizationId).toBe(ORG_DO_TOKEN);
    expect(r.via).toBe("token");
    // requireRole nem chega a ser consultado quando há Bearer.
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("recusa token de leitura numa rota de escrita", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG_DO_TOKEN,
      scopes: ["mcp:read"],
      role: "agent",
      actor: { type: "api_token", id: "tok-1" },
    } as never);

    const r = await resolveAuthDual(req({ authorization: "Bearer dsk_abc" }), OPCOES);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(403);
  });

  it("token inválido fecha em 401 e não cai na sessão", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token inválido."),
    );

    const r = await resolveAuthDual(req({ authorization: "Bearer dsk_ruim" }), OPCOES);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("sem Authorization, usa a sessão", async () => {
    sessaoOk();

    const r = await resolveAuthDual(req(), OPCOES);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.organizationId).toBe(ORG_DA_SESSAO);
    expect(r.via).toBe("session");
    expect(validateBearerToken).not.toHaveBeenCalled();
  });

  // #1613: o gate de `messages:on_behalf` na rota lê `scopes` daqui. Se o ramo
  // do token não os devolver, a rota recusa todo "em nome de" com 403 — e os
  // testes da rota não veem, porque mockam `resolveAuthDual` já com `scopes`.
  it("no ramo do token, devolve os scopes e o id da linha do token", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG_DO_TOKEN,
      scopes: ["mcp:write", "messages:on_behalf"],
      role: "agent",
      apiTokenId: "tok-1",
      actor: { type: "api_token", id: "tok-1" },
    } as never);

    const r = await resolveAuthDual(req({ authorization: "Bearer dsk_abc" }), OPCOES);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toContain("messages:on_behalf");
    expect(r.apiTokenId).toBe("tok-1");
  });

  it("a sessão não carrega scopes: campo condicionado a escopo fica fechado para a tela", async () => {
    sessaoOk();

    const r = await resolveAuthDual(req(), OPCOES);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scopes).toBeUndefined();
    expect(r.apiTokenId).toBeUndefined();
  });
});

describe("os caminhos de envio passam pelo proxy", () => {
  // Sem estas entradas o proxy responde 401 antes do handler, e a dualidade
  // acima fica inalcançável por token mesmo estando implementada.
  it("libera as tres rotas de envio", () => {
    expect(isPublicPath("/api/v1/messages")).toBe(true);
    expect(isPublicPath("/api/v1/conversations/open-with-contact")).toBe(true);
    // Mídia: sem ela o cartão de fidelidade não sai depois do corte.
    expect(isPublicPath("/api/v1/conversations/abc-123/media")).toBe(true);
  });

  it("não dá carona a sub-paths que não têm suporte a Bearer", () => {
    expect(isPublicPath("/api/v1/messages/alguma-mensagem")).toBe(false);
    expect(isPublicPath("/api/v1/conversations/alguma-conversa")).toBe(false);
    // A entrada de mídia é ancorada: não libera irmãs como /notes ou /claim.
    expect(isPublicPath("/api/v1/conversations/abc-123/notes")).toBe(false);
    expect(isPublicPath("/api/v1/conversations/abc-123/media/extra")).toBe(false);
  });
});
