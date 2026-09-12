/**
 * GET /api/v1/contacts — dois modos de autenticação.
 *
 * a) sessão de navegador → `requireRole("viewer", …)` (mesmo gate do resto de
 *    `/api/v1/*`).
 * b) `Authorization: Bearer dsk_…` → `validateBearerToken()` (`lib/mcp/auth.ts`),
 *    o MESMO autenticador que o MCP server usa para `api_tokens`.
 *
 * `organization_id` nunca vem do cliente: no modo sessão vem do cookie
 * validado contra memberships (`requireRole`); no modo Bearer vem da LINHA DO
 * TOKEN no banco (`validateBearerToken`). Isto é o que a suíte prova.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { isPublicPath } from "@/lib/auth/public-paths";
import { McpAuthError, extractBearer } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listContactsHandler } from "./_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("./_handler", () => ({
  listContactsHandler: vi.fn(async () => ({ contacts: [], cursor: null, has_more: false })),
  createContactHandler: vi.fn(),
}));

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

// Precisa vir DEPOIS do vi.mock acima — pega a versão mockada de validateBearerToken.
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const FAKE_SESSION_CLIENT = { session: true } as never;
const FAKE_ADMIN_CLIENT = { admin: true } as never;

function req(url = "http://localhost/api/v1/contacts", headers?: HeadersInit) {
  return new NextRequest(url, { headers });
}

function sessaoOk(): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "viewer" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "viewer" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue(FAKE_SESSION_CLIENT);
  vi.mocked(createAdminClient).mockReturnValue(FAKE_ADMIN_CLIENT);
});

describe("GET /api/v1/contacts — sessão de navegador", () => {
  it("sessão válida → 200, lista contatos da org ativa (client de cookie)", async () => {
    sessaoOk();
    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(vi.mocked(listContactsHandler).mock.calls[0]?.[0]).toBe(FAKE_SESSION_CLIENT);
    expect(vi.mocked(listContactsHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "user", id: USER_ID },
    });
  });

  it("sem sessão e sem Bearer → 401, repassa a resposta de requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(listContactsHandler).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/contacts — Bearer (integrações externas)", () => {
  function tokenOk(over: Partial<{ organizationId: string; scopes: string[]; role: string }> = {}) {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: over.organizationId ?? ORG_ID,
      role: (over.role ?? "agent") as never,
      actor: { type: "ai_agent", id: "run-1", role: (over.role ?? "agent") as never, api_token_id: "tok-1" },
      apiTokenId: "tok-1",
      scopes: over.scopes ?? ["mcp:read"],
    });
  }

  it("Bearer válido com scope mcp:read → 200, org resolvida do TOKEN (client admin)", async () => {
    tokenOk({ organizationId: ORG_ID });
    const { GET } = await import("./route");
    const res = await GET(req("http://localhost/api/v1/contacts", { authorization: "Bearer dsk_abc_def" }));

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(vi.mocked(listContactsHandler).mock.calls[0]?.[0]).toBe(FAKE_ADMIN_CLIENT);
    expect(vi.mocked(listContactsHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "ai_agent", api_token_id: "tok-1" },
    });
  });

  it("Bearer inválido/revogado → 401, nenhuma chamada ao handler", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const { GET } = await import("./route");
    const res = await GET(req("http://localhost/api/v1/contacts", { authorization: "Bearer dsk_xxx_yyy" }));

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
    expect(listContactsHandler).not.toHaveBeenCalled();
  });

  it("Bearer sem o header Authorization → cai no modo sessão (não trata string vazia como token)", async () => {
    sessaoOk();
    const { GET } = await import("./route");
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(requireRole).toHaveBeenCalled();
  });

  it("Bearer válido SEM scope mcp:read → 403, nenhuma chamada ao handler", async () => {
    tokenOk({ scopes: [] });
    const { GET } = await import("./route");
    const res = await GET(req("http://localhost/api/v1/contacts", { authorization: "Bearer dsk_abc_def" }));

    expect(res.status).toBe(403);
    expect(listContactsHandler).not.toHaveBeenCalled();
  });

  it("token de UMA organização nunca lê contatos de OUTRA — organization_id vem do token, não do cliente", async () => {
    // Mesmo que a chamada tente insinuar outra org via querystring, o schema de
    // query não aceita `organization_id` — e o handler só recebe o que o TOKEN
    // resolveu no banco.
    tokenOk({ organizationId: ORG_ID });
    const { GET } = await import("./route");
    const res = await GET(
      req(`http://localhost/api/v1/contacts?organization_id=${OUTRA_ORG}`, {
        authorization: "Bearer dsk_abc_def",
      }),
    );

    expect(res.status).toBe(200);
    expect(vi.mocked(listContactsHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
    });
  });

  it("extractBearer não confunde header ausente com token vazio", () => {
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("Bearer ")).toBeNull();
  });
});

/**
 * ⭐ O DEFEITO QUE OS TESTES ACIMA NÃO PEGAM.
 *
 * `proxy.ts` roda ANTES de qualquer route handler e responde 401 sozinho para
 * quem não tem cookie de sessão — inclusive Bearer válido — a menos que o path
 * esteja em `PUBLIC_PATHS` (lib/auth/public-paths.ts). Os testes acima chamam
 * `GET()` direto, sem passar pelo proxy, e por isso ficam verdes mesmo que o
 * path não esteja na lista — foi exatamente isso que aconteceu em produção
 * (medido: Bearer correto, 401 "Authentication required", a mensagem do PROXY,
 * não da rota). Este teste é o único que prova a integração das duas camadas.
 */
describe("GET /api/v1/contacts — alcançável sem cookie (proxy)", () => {
  it("está em PUBLIC_PATHS — senão o proxy barra o Bearer antes da rota decidir", () => {
    expect(
      isPublicPath("/api/v1/contacts"),
      "sem esta entrada, todo Bearer válido recebe 401 do proxy.ts antes de chegar " +
        "em app/api/v1/contacts/route.ts — o 401 vem com a mensagem genérica do proxy " +
        '("Authentication required"), não com a da rota.',
    ).toBe(true);
  });

  it("NÃO libera sub-rotas que ainda não suportam Bearer", () => {
    expect(isPublicPath("/api/v1/contacts/algum-id")).toBe(false);
    expect(isPublicPath("/api/v1/contacts/import")).toBe(false);
  });
});
