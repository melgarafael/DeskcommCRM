/**
 * POST /api/v1/agenda/agendamentos — dois modos de autenticação, mesmo padrão
 * de `app/api/v1/contacts/route.test.ts` (a origem do auth-dual). PATCH e
 * DELETE passam pela MESMA função (`despachar`), então provar o POST prova o
 * mecanismo — a diferença entre os três é só schema e handler, não auth.
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
import {
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
  marcarAgendamentoHandler,
} from "./_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
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

const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
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
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
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
  // `ai_operator` por padrão: é o papel que as tools MCP de escrita na agenda
  // exigem, e a rota exige o MESMO do token (ver o caso "token agent → 403").
  function tokenOk(over: Partial<{ organizationId: string; scopes: string[]; role: string }> = {}) {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: over.organizationId ?? ORG_ID,
      role: (over.role ?? "ai_operator") as never,
      // Token de servidor SEM o scope `actor:ai_agent` vira `api_token`
      // (`lib/mcp/auth.ts`, `deriveActor`) — é o que n8n usaria de fato.
      actor: { type: "api_token", id: "tok-1", role: (over.role ?? "ai_operator") as never },
      apiTokenId: "tok-1",
      scopes: over.scopes ?? ["mcp:write"],
    });
  }

  it("token ai_operator (o papel das tools MCP da agenda) com mcp:write → 201, org do TOKEN, actor api_token (client admin)", async () => {
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

  it("token `agent` (o papel com que todo token da tela nasce) → 403 nos TRÊS verbos, handler não roda", async () => {
    tokenOk({ role: "agent" });
    const { POST, PATCH, DELETE } = await import("./route");
    const auth = { authorization: "Bearer dsk_abc_def" };
    const ID = "55555555-5555-4555-8555-555555555555";
    const respostas = [
      await POST(postReq(BODY, auth)),
      await PATCH(
        new NextRequest("http://localhost/api/v1/agenda/agendamentos", {
          method: "PATCH",
          body: JSON.stringify({ id: ID, notes: "x" }),
          headers: { "content-type": "application/json", ...auth },
        }),
      ),
      await DELETE(
        new NextRequest("http://localhost/api/v1/agenda/agendamentos", {
          method: "DELETE",
          body: JSON.stringify({ id: ID, reason: "desmarcado pelo tribunal" }),
          headers: { "content-type": "application/json", ...auth },
        }),
      ),
    ];

    expect(respostas.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
    expect(alterarAgendamentoHandler).not.toHaveBeenCalled();
    expect(cancelarAgendamentoHandler).not.toHaveBeenCalled();
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

/**
 * A rota está em `PUBLIC_PATHS`: não há estrangulamento a montante. O teto por
 * token e por organização (o mesmo de `/api/v1/messages`, #1491) é o único que
 * existe para uma integração em laço.
 */
describe("POST /api/v1/agenda/agendamentos — teto de escrita do Bearer", () => {
  function tokenOk(): void {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG_ID,
      role: "ai_operator" as never,
      actor: { type: "api_token", id: "tok-1", role: "ai_operator" as never },
      apiTokenId: "tok-1",
      scopes: ["mcp:write"],
    });
  }

  it("acima do teto do token → 429 com Retry-After, handler não roda", async () => {
    tokenOk();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);
    const mod = await import("./route");
    const res = await mod.POST(postReq(BODY, { authorization: "Bearer dsk_abc_def" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("acima do teto da organização → 429, handler não roda", async () => {
    tokenOk();
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true } as never)
      .mockResolvedValueOnce({ allowed: false } as never);
    const mod = await import("./route");
    const res = await mod.POST(postReq(BODY, { authorization: "Bearer dsk_abc_def" }));

    expect(res.status).toBe(429);
    expect(marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("organization_id no corpo é ignorado: a org é a da LINHA DO TOKEN", async () => {
    tokenOk();
    const mod = await import("./route");
    const res = await mod.POST(
      postReq({ ...BODY, organization_id: OUTRA_ORG }, { authorization: "Bearer dsk_abc_def" }),
    );

    expect(res.status).toBeLessThan(300);
    expect(vi.mocked(marcarAgendamentoHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
    });
  });

  it("pela sessão não há teto — o contador nem é tocado", async () => {
    sessaoOk();
    const mod = await import("./route");
    const res = await mod.POST(postReq(BODY));

    expect(res.status).toBeLessThan(300);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

/**
 * `/api/v1/agenda/agendamentos` agora está em `PUBLIC_PATHS` — o proxy deixa de
 * barrar o GET sem cookie. Quem barra é o `requireRole` da própria rota, que
 * NÃO lê Bearer: listar a agenda segue só-sessão.
 */
describe("GET /api/v1/agenda/agendamentos — continua só-sessão", () => {
  it("Bearer válido e sem sessão → 401, e o token nem é consultado", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG_ID,
      role: "admin" as never,
      actor: { type: "api_token", id: "tok-1", role: "admin" as never },
      apiTokenId: "tok-1",
      scopes: ["mcp:read", "mcp:write"],
    });
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    } as never);
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/agenda/agendamentos?de=2026-10-01T00:00:00Z&ate=2026-10-08T00:00:00Z",
        { method: "GET", headers: { authorization: "Bearer dsk_abc_def" } },
      ),
    );

    expect(res.status).toBe(401);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
