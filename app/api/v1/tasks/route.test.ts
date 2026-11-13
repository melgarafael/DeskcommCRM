/**
 * AS ROTAS DE TAREFA POR TOKEN (#4516), na BORDA.
 *
 * O que se prova aqui é o que o handler NÃO pode provar sozinho: a rota
 * identifica o token, cobra o ESCOPO PRÓPRIO e passa a organização da LINHA DO
 * TOKEN para o handler. O resto (idempotência de verdade, isolamento por
 * organização) vive em `tests/unit/tarefas-por-token-4516.test.ts`, com o
 * `_handler` real.
 *
 * ⚠️ `tasks:read`/`tasks:write` NÃO são `mcp:read`/`mcp:write`. Um token
 * emitido para uma integração de ligações recebe `mcp:write` junto de tudo o
 * mais; apagar e concluir tarefa mexe na rotina de gente, então quem emite o
 * token decide. O caso "token com mcp:write e SEM tasks:write → 403" é o que
 * impede o escopo novo de nascer decorativo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireRole } from "@/lib/auth/require-role";
import { isPublicPath } from "@/lib/auth/public-paths";
import type { AuthUser } from "@/lib/auth/types";
import { McpAuthError } from "@/lib/mcp/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarTarefaHandler, listarTarefasHandler } from "./_handler";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("./_handler", () => ({
  LIMITE_MAXIMO_DA_LISTA: 500,
  listarTarefasHandler: vi.fn(async () => ({ tasks: [] })),
  criarTarefaHandler: vi.fn(async () => ({ task: { id: "t-1" } })),
}));

vi.mock("@/lib/mcp/auth", async () => {
  const real = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...real, validateBearerToken: vi.fn() };
});

const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG_ID = "22222222-4516-4222-8222-222222222222";
const USER_ID = "11111111-4516-4111-8111-111111111111";
const CHAVE = "33333333-4516-4333-8333-333333333333";

const FAKE_ADMIN_CLIENT = { admin: true } as never;
const FAKE_SESSION_CLIENT = { session: true } as never;

function tokenOk(scopes: string[]): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_ID,
    role: "agent" as never,
    actor: { type: "api_token", id: "tok-4516", role: "agent" as never },
    apiTokenId: "tok-4516",
    scopes,
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

function req(
  metodo: string,
  caminho = "/api/v1/tasks",
  corpo?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${caminho}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue(FAKE_SESSION_CLIENT);
  vi.mocked(createAdminClient).mockReturnValue(FAKE_ADMIN_CLIENT);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("#4516 — GET /api/v1/tasks aceita Bearer com `tasks:read`", () => {
  it("token sem `tasks:read` → 403, handler não roda", async () => {
    tokenOk(["mcp:read"]);
    const { GET } = await import("./route");

    const res = await GET(req("GET", "/api/v1/tasks", undefined, { authorization: "Bearer dsk_a_b" }));

    expect(res.status).toBe(403);
    expect(listarTarefasHandler).not.toHaveBeenCalled();
  });

  it("token com `tasks:read` → 200, e a organização vem do TOKEN", async () => {
    tokenOk(["mcp:read", "tasks:read"]);
    const { GET } = await import("./route");

    const res = await GET(
      req("GET", "/api/v1/tasks?aberto=true", undefined, { authorization: "Bearer dsk_a_b" }),
    );

    expect(res.status).toBe(200);
    expect(requireRole).not.toHaveBeenCalled();
    expect(vi.mocked(listarTarefasHandler).mock.calls[0]?.[0]).toBe(FAKE_ADMIN_CLIENT);
    expect(vi.mocked(listarTarefasHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      apiTokenId: "tok-4516",
      actor: { type: "api_token", id: "tok-4516" },
    });
  });

  it("`assigned_to=me` por token → 422 nomeado, em vez de lista vazia silenciosa", async () => {
    // Não há pessoa na linha do token. Resolver `me` para o id do token
    // devolveria zero tarefas e o cliente acharia que a equipe não tem nada.
    tokenOk(["tasks:read"]);
    const { GET } = await import("./route");

    const res = await GET(
      req("GET", "/api/v1/tasks?assigned_to=me", undefined, { authorization: "Bearer dsk_a_b" }),
    );

    expect(res.status).toBe(422);
    expect(listarTarefasHandler).not.toHaveBeenCalled();
  });

  it("a sessão de navegador continua entrando por cookie, com `assigned_to=me` resolvido", async () => {
    sessaoOk();
    const { GET } = await import("./route");

    const res = await GET(req("GET", "/api/v1/tasks?assigned_to=me"));

    expect(res.status).toBe(200);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(vi.mocked(listarTarefasHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      actor: { type: "user", id: USER_ID },
    });
  });
});

describe("#4516 — POST /api/v1/tasks aceita Bearer com `tasks:write`", () => {
  const CORPO = { title: "Ligar de volta para a Ana" };

  it("token com `mcp:write` e SEM `tasks:write` → 403, handler não roda", async () => {
    tokenOk(["mcp:write"]);
    const { POST } = await import("./route");

    const res = await POST(req("POST", "/api/v1/tasks", CORPO, { authorization: "Bearer dsk_a_b" }));

    expect(res.status).toBe(403);
    expect(criarTarefaHandler).not.toHaveBeenCalled();
  });

  it("token com `tasks:write` e Idempotency-Key → 201, chave e procedência chegam ao handler", async () => {
    tokenOk(["mcp:write", "tasks:write"]);
    const { POST } = await import("./route");

    const res = await POST(
      req("POST", "/api/v1/tasks", CORPO, {
        authorization: "Bearer dsk_a_b",
        "Idempotency-Key": CHAVE,
      }),
    );

    expect(res.status).toBe(201);
    expect(vi.mocked(criarTarefaHandler).mock.calls[0]?.[1]).toMatchObject({
      organization_id: ORG_ID,
      idempotencyKey: CHAVE,
      apiTokenId: "tok-4516",
    });
  });

  it("Idempotency-Key que não é UUID → 400, antes de qualquer escrita", async () => {
    tokenOk(["tasks:write"]);
    const { POST } = await import("./route");

    const res = await POST(
      req("POST", "/api/v1/tasks", CORPO, {
        authorization: "Bearer dsk_a_b",
        "Idempotency-Key": "nao-e-uuid",
      }),
    );

    expect(res.status).toBe(400);
    expect(criarTarefaHandler).not.toHaveBeenCalled();
  });

  it("token sem `tasks:write` não passa nem com sessão inválida na mesma requisição", async () => {
    // O caminho do Bearer é EXCLUSIVO: se o token está presente, quem decide é
    // ele. Um cookie esquecido no cliente não pode rebaixar a checagem.
    tokenOk(["mcp:write"]);
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    } as never);
    const { POST } = await import("./route");

    const res = await POST(req("POST", "/api/v1/tasks", CORPO, { authorization: "Bearer dsk_a_b" }));

    expect(res.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("Bearer inválido → 401, nenhuma chamada ao handler", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token not recognized."),
    );
    const { POST } = await import("./route");

    const res = await POST(req("POST", "/api/v1/tasks", CORPO, { authorization: "Bearer dsk_x_y" }));

    expect(res.status).toBe(401);
    expect(criarTarefaHandler).not.toHaveBeenCalled();
  });
});

/**
 * ⭐ SEM ESTAS LINHAS O BEARER NUNCA CHEGA À ROTA.
 *
 * `proxy.ts` roda ANTES de qualquer handler e só reconhece cookie: um Bearer
 * válido recebia `401 unauthenticated` do proxy, e a rota — com autenticação
 * dupla perfeita — nunca era executada. É o mesmo modo de falha medido em
 * `/api/v1/contacts` (#3417) e em `/api/v1/agenda/agendamentos`.
 */
describe("#4516 — os caminhos de tarefa são alcançáveis sem cookie (proxy)", () => {
  const ID = "55555555-4516-4555-8555-555555555555";

  it("a coleção e o item estão na lista de caminhos que o proxy não decide", () => {
    expect(isPublicPath("/api/v1/tasks")).toBe(true);
    expect(isPublicPath(`/api/v1/tasks/${ID}`)).toBe(true);
  });

  it("nada mais nasce público de carona", () => {
    // O segmento do id é FORMA DE UUID, e a âncora fecha o caminho: um irmão
    // futuro (`/api/v1/tasks/export`, `/api/v1/tasks/<id>/comentarios`) não é
    // "público" sem alguém decidir isso.
    expect(isPublicPath("/api/v1/tasks/export")).toBe(false);
    expect(isPublicPath(`/api/v1/tasks/${ID}/comentarios`)).toBe(false);
    expect(isPublicPath("/api/v1/tasks/")).toBe(false);
  });
});
