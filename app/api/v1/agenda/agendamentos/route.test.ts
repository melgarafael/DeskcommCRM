/**
 * POST /api/v1/agenda/agendamentos — dois modos de autenticação, mesmo padrão
 * de `app/api/v1/contacts/route.test.ts` (a origem do auth-dual). PATCH e
 * DELETE passam pela MESMA função (`despachar`), então provar o POST prova o
 * mecanismo — a diferença entre os três é só schema e handler, não auth.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { isPublicPath } from "@/lib/auth/public-paths";
import { McpAuthError } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { marcarAgendamentoHandler } from "./_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("./_handler", () => ({
  marcarAgendamentoHandler: vi.fn(async () => ({ id: "ag-1", status: "pending" })),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

// Precisa vir DEPOIS do vi.mock acima — pega a versão mockada de validateBearerToken.
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_TYPE_ID = "44444444-4444-4444-8444-444444444444";

const FAKE_SESSION_CLIENT = { session: true } as never;
const FAKE_ADMIN_CLIENT = { admin: true } as never;

const BODY = { event_type_id: EVENT_TYPE_ID, starts_at: "2026-10-06T14:00:00-03:00" };

function postReq(body: unknown = BODY, headers?: HeadersInit): NextRequest {
  return new NextRequest("http://localhost/api/v1/agenda/agendamentos", {
    method: "POST",
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
});

describe("POST /api/v1/agenda/agendamentos — sessão de navegador", () => {
  it("sessão válida → 201, marca (client de cookie, actor de USUÁRIO)", async () => {
    sessaoOk();
    const { POST } = await import("./route");
    const res = await POST(postReq());

    expect(res.status).toBe(201);
    expect(vi.mocked(marcarAgendamentoHandler).mock.calls[0]?.[0]).toBe(FAKE_SESSION_CLIENT);
    expect(vi.mocked(marcarAgendamentoHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "user", id: USER_ID },
    });
  });

  it("sem sessão e sem Bearer → 401, repassa a resposta de requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    } as never);
    const { POST } = await import("./route");
    const res = await POST(postReq());

    expect(res.status).toBe(401);
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/agenda/agendamentos — Bearer (monitoramento processual)", () => {
  function tokenOk(over: Partial<{ organizationId: string; scopes: string[] }> = {}) {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: over.organizationId ?? ORG_ID,
      role: "agent" as never,
      // Token de servidor SEM o scope `actor:ai_agent` vira `api_token`
      // (`lib/mcp/auth.ts`, `deriveActor`) — é o que n8n usaria de fato.
      actor: { type: "api_token", id: "tok-1", role: "agent" as never },
      apiTokenId: "tok-1",
      scopes: over.scopes ?? ["mcp:write"],
    });
  }

  it("Bearer válido com scope mcp:write → 201, org do TOKEN, actor api_token (client admin)", async () => {
    tokenOk({ organizationId: ORG_ID });
    const { POST } = await import("./route");
    const res = await POST(postReq(BODY, { authorization: "Bearer dsk_abc_def" }));

    expect(res.status).toBe(201);
    expect(requireRole).not.toHaveBeenCalled();
    expect(vi.mocked(marcarAgendamentoHandler).mock.calls[0]?.[0]).toBe(FAKE_ADMIN_CLIENT);
    expect(vi.mocked(marcarAgendamentoHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "api_token", id: "tok-1" },
    });
  });

  it("Bearer inválido/revogado → 401, nenhuma chamada ao handler", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const { POST } = await import("./route");
    const res = await POST(postReq(BODY, { authorization: "Bearer dsk_xxx_yyy" }));

    expect(res.status).toBe(401);
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("Bearer válido SEM scope mcp:write → 403, nenhuma chamada ao handler", async () => {
    tokenOk({ scopes: ["mcp:read"] });
    const { POST } = await import("./route");
    const res = await POST(postReq(BODY, { authorization: "Bearer dsk_abc_def" }));

    expect(res.status).toBe(403);
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
  });
});

/**
 * ⭐ O DEFEITO QUE OS TESTES ACIMA NÃO PEGAM — mesma nota de
 * `app/api/v1/contacts/route.test.ts`: `proxy.ts` roda ANTES de qualquer route
 * handler; sem entrada em `PUBLIC_PATHS`, um Bearer válido recebe 401 do PROXY
 * antes de a rota decidir qualquer coisa.
 */
describe("POST /api/v1/agenda/agendamentos — alcançável sem cookie (proxy)", () => {
  it("está em PUBLIC_PATHS — senão o proxy barra o Bearer antes da rota decidir", () => {
    expect(isPublicPath("/api/v1/agenda/agendamentos")).toBe(true);
  });
});
