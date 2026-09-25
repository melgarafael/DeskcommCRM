/**
 * PATCH /api/v1/leads/[id] — dois modos de autenticação (mesmo padrão de
 * `app/api/v1/contacts/route.test.ts`, a origem do auth-dual).
 *
 * a) sessão de navegador → `requireRole("agent", …)`.
 * b) `Authorization: Bearer dsk_…` → `validateBearerToken()`, o autenticador
 *    que o MCP server usa para `api_tokens`.
 *
 * `organization_id` nunca vem do cliente: no modo sessão vem do cookie
 * validado; no modo Bearer vem da LINHA DO TOKEN no banco. É o que esta
 * suíte prova — a integração de monitoramento processual (n8n) é o
 * consumidor real do modo Bearer aqui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { isPublicPath } from "@/lib/auth/public-paths";
import { McpAuthError } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { updateLeadHandler } from "../_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("../_handler", () => ({
  updateLeadHandler: vi.fn(async () => ({ id: "l-1", title: "Atualizado" })),
}));

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

// Precisa vir DEPOIS do vi.mock acima — pega a versão mockada de validateBearerToken.
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";

const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const FAKE_SESSION_CLIENT = { session: true } as never;
const FAKE_ADMIN_CLIENT = { admin: true } as never;

const params = { params: Promise.resolve({ id: LEAD_ID }) };

function patchReq(body: unknown, headers?: HeadersInit): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function sessaoOk(): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue(FAKE_SESSION_CLIENT);
  vi.mocked(createAdminClient).mockReturnValue(FAKE_ADMIN_CLIENT);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("PATCH /api/v1/leads/[id] — sessão de navegador", () => {
  it("sessão válida → 200, atualiza (client de cookie)", async () => {
    sessaoOk();
    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ title: "Novo título" }), params);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]?.[0]).toBe(FAKE_SESSION_CLIENT);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "user", id: USER_ID },
    });
  });

  it("sem sessão e sem Bearer → 401, repassa a resposta de requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    } as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(patchReq({ title: "x" }), params);

    expect(res.status).toBe(401);
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/leads/[id] — Bearer (monitoramento processual)", () => {
  function tokenOk(over: Partial<{ organizationId: string; scopes: string[]; role: string }> = {}) {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: over.organizationId ?? ORG_ID,
      role: (over.role ?? "agent") as never,
      actor: {
        type: "ai_agent",
        id: "run-1",
        role: (over.role ?? "agent") as never,
        api_token_id: "tok-1",
      },
      apiTokenId: "tok-1",
      scopes: over.scopes ?? ["mcp:write"],
    });
  }

  it("Bearer válido com scope mcp:write → 200, org resolvida do TOKEN (client admin)", async () => {
    tokenOk({ organizationId: ORG_ID });
    const { PATCH } = await import("./route");
    const res = await PATCH(
      patchReq(
        { custom_fields: { "Andamento atual": "aguardando laudo pericial" } },
        {
          authorization: "Bearer dsk_abc_def",
        },
      ),
      params,
    );

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(vi.mocked(updateLeadHandler).mock.calls[0]?.[0]).toBe(FAKE_ADMIN_CLIENT);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "ai_agent", api_token_id: "tok-1" },
    });
  });

  it("Bearer inválido/revogado → 401, nenhuma chamada ao handler", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const { PATCH } = await import("./route");
    const res = await PATCH(
      patchReq({ title: "x" }, { authorization: "Bearer dsk_xxx_yyy" }),
      params,
    );

    expect(res.status).toBe(401);
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });

  it("Bearer válido SEM scope mcp:write → 403, nenhuma chamada ao handler", async () => {
    tokenOk({ scopes: ["mcp:read"] });
    const { PATCH } = await import("./route");
    const res = await PATCH(
      patchReq({ title: "x" }, { authorization: "Bearer dsk_abc_def" }),
      params,
    );

    expect(res.status).toBe(403);
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });
});

/**
 * ⭐ O DEFEITO QUE OS TESTES ACIMA NÃO PEGAM — mesma nota de
 * `app/api/v1/contacts/route.test.ts`: `proxy.ts` roda ANTES de qualquer route
 * handler; sem entrada em `PUBLIC_PATHS`, um Bearer válido recebe 401 do PROXY
 * antes de a rota decidir qualquer coisa. Os testes acima chamam `PATCH()`
 * direto, sem passar pelo proxy — este é o único que prova a integração.
 */
describe("PATCH /api/v1/leads/[id] — alcançável sem cookie (proxy)", () => {
  it("está em PUBLIC_PATHS pela forma de UUID — senão o proxy barra o Bearer antes da rota decidir", () => {
    expect(isPublicPath(`/api/v1/leads/${LEAD_ID}`)).toBe(true);
  });

  it("NÃO libera os irmãos literais de /api/v1/leads/, que não têm Bearer", () => {
    expect(isPublicPath("/api/v1/leads/bulk")).toBe(false);
  });
});

/**
 * A rota está em `PUBLIC_PATHS`: não há estrangulamento a montante. O teto por
 * token e por organização (o mesmo de `/api/v1/messages`, #1491) é o único que
 * existe para uma integração em laço.
 */
describe("PATCH /api/v1/leads/[id] — teto de escrita do Bearer", () => {
  function tokenOk(): void {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG_ID,
      role: "agent" as never,
      actor: { type: "api_token", id: "tok-1", role: "agent" as never },
      apiTokenId: "tok-1",
      scopes: ["mcp:write"],
    });
  }

  it("acima do teto do token → 429 com Retry-After, handler não roda", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);
    const mod = await import("./route");
    const res = await mod.PATCH(
      patchReq({ title: "Novo título" }, { authorization: "Bearer dsk_abc_def" }),
      params,
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });

  it("acima do teto da organização → 429, handler não roda", async () => {
    tokenOk();
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true } as never)
      .mockResolvedValueOnce({ allowed: false } as never);
    const mod = await import("./route");
    const res = await mod.PATCH(
      patchReq({ title: "Novo título" }, { authorization: "Bearer dsk_abc_def" }),
      params,
    );

    expect(res.status).toBe(429);
    expect(updateLeadHandler).not.toHaveBeenCalled();
  });

  it("organization_id no corpo é ignorado: a org é a da LINHA DO TOKEN", async () => {
    tokenOk();
    const mod = await import("./route");
    const res = await mod.PATCH(
      patchReq(
        { title: "Novo título", organization_id: OUTRA_ORG },
        { authorization: "Bearer dsk_abc_def" },
      ),
      params,
    );

    expect(res.status).toBeLessThan(300);
    expect(vi.mocked(updateLeadHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
    });
  });

  it("pela sessão não há teto — o contador nem é tocado", async () => {
    sessaoOk();
    const mod = await import("./route");
    const res = await mod.PATCH(patchReq({ title: "Novo título" }), params);

    expect(res.status).toBeLessThan(300);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
