/**
 * #2052 — CONFIGURAR o agente por Bearer `dsk_…`, sem navegador.
 *
 * A porta `GET /api/v1/ai/agents/:id/versions/:vid` exigia sessão de cookie
 * (`requireRole` + MFA de sessão) e respondia 401 a um token de servidor. Ela
 * passa a chamar `lib/api/auth-dual.ts`, como as demais rotas de configuração.
 *
 * O que não pode regredir:
 *
 *  1. Bearer com `config:read` E papel admin é ACEITO: a org sai da LINHA DO
 *     TOKEN (a rota filtra `organization_id` por ela), a sessão nem é
 *     consultada, e a resposta é do banco — 404, não 401.
 *  2. RECUSA: sem o escopo exigido → 403; com o escopo mas papel abaixo do
 *     mínimo do token (`tokenRole: "admin"`) → 403; token inválido → 401.
 *     `mcp:write` sozinho não vira poder a mais nesta porta de leitura.
 *  4. DECISÃO DO MANTENEDOR (PR #2194): configurar o agente é escopo PRÓPRIO
 *     (`config:read`/`config:write`). O token que JÁ existe nas VPS —
 *     `mcp:read`/`mcp:write` + `role:admin` — não ganha nada na atualização:
 *     403 em toda porta desta issue. Só um token NOVO com `config:write` edita,
 *     testa, publica, pausa e arquiva, e a auditoria grava o id do token.
 *  3. Sem `Authorization`, o caminho é a SESSÃO de sempre: `requireRole` manda
 *     e, sem sessão, 401 — igual antes desta issue.
 *
 * Os quatro caminhos também precisam de entrada em `lib/auth/public-paths.ts`
 * (sem ela o `proxy.ts` devolve 401 antes do handler); a cobertura deles está
 * em `lib/api/auth-dual.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));

const ORG_DO_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

/** `eq` registra os filtros: é assim que se prova que a org veio do token. */
const filtros: [string, unknown][] = [];

function supabaseVazio() {
  const n: Record<string, unknown> = {};
  n.from = () => n;
  n.select = () => n;
  n.eq = (coluna: string, valor: unknown) => {
    filtros.push([coluna, valor]);
    return n;
  };
  n.maybeSingle = async () => ({ data: null, error: null });
  return n;
}

function token(cenarios: { scopes: string[]; role: string }): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    scopes: cenarios.scopes,
    role: cenarios.role,
    actor: { type: "api_token", id: "tok-1", role: cenarios.role },
    apiTokenId: "tok-1",
  } as never);
}

async function get(headers?: Record<string, string>): Promise<Response> {
  const { GET } = await import("@/app/api/v1/ai/agents/[id]/versions/[vid]/route");
  const req = new NextRequest(
    `http://localhost/api/v1/ai/agents/${AGENT}/versions/${VERSION}`,
    { headers },
  );
  return GET(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  filtros.length = 0;
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  } as never);
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    scopes: ["config:read"],
    role: "admin",
    actor: { type: "api_token", id: "tok-1", role: "admin" },
    apiTokenId: "tok-1",
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(supabaseVazio() as never);
});

describe("configurar o agente por token (issue #2052)", () => {
  it("aceita Bearer com config:read e papel admin, e filtra a org pela linha do token", async () => {
    token({ scopes: ["config:read"], role: "admin" });

    const res = await get({ authorization: "Bearer dsk_abc_def" });

    // Passou pela auth e chegou ao banco: 404 = o supabase devolveu vazio.
    // 401/403 aqui seriam a porta fechada que a issue denuncia.
    expect(res.status).toBe(404);
    expect(validateBearerToken).toHaveBeenCalledWith(
      expect.stringMatching(/^Bearer dsk_abc_def$/),
    );
    // A sessão não é consultada quando há Bearer.
    expect(requireRole).not.toHaveBeenCalled();
    // organization_id vem do TOKEN, nunca do path nem de query.
    expect(filtros).toContainEqual(["organization_id", ORG_DO_TOKEN]);
  });

  it("recusa token sem o escopo exigido (403)", async () => {
    token({ scopes: ["mcp:write"], role: "admin" });

    const res = await get({ authorization: "Bearer dsk_abc_def" });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
  });

  it("recusa token com o escopo mas papel abaixo do mínimo (403)", async () => {
    // `tokenRole: "admin"`: configuração não é poder de gerente para quem
    // entra por token, mesmo que a sessão de gerente leia a mesma rota.
    token({ scopes: ["config:read"], role: "manager" });

    const res = await get({ authorization: "Bearer dsk_abc_def" });

    expect(res.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("recusa token inválido com 401 e não cai na sessão", async () => {
    const { McpAuthError } = await import("@/lib/mcp/auth");
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token inválido."),
    );

    const res = await get({ authorization: "Bearer dsk_ruim_ruim" });

    expect(res.status).toBe(401);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("sem Authorization continua na sessão: 401 quando não há sessão", async () => {
    const res = await get();

    expect(res.status).toBe(401);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(requireRole).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Decisão do mantenedor (PR #2194): escopo próprio, token antigo não ganha nada.
// ---------------------------------------------------------------------------

const BEARER = { authorization: "Bearer dsk_abc_def", "content-type": "application/json" };

type Porta = { nome: string; chamar: () => Promise<Response> };

function req(caminho: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}${caminho}`, {
    method,
    headers: BEARER,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const PORTAS_DE_ESCRITA: Porta[] = [
  {
    nome: "PATCH /agents/:id (pausar, alterar)",
    chamar: async () => {
      const { PATCH } = await import("@/app/api/v1/ai/agents/[id]/route");
      return PATCH(req("", "PATCH", { paused_at: "2026-10-05T12:00:00.000Z" }), {
        params: Promise.resolve({ id: AGENT }),
      });
    },
  },
  {
    nome: "DELETE /agents/:id (arquivar)",
    chamar: async () => {
      const { DELETE } = await import("@/app/api/v1/ai/agents/[id]/route");
      return DELETE(req("", "DELETE"), { params: Promise.resolve({ id: AGENT }) });
    },
  },
  {
    nome: "PATCH /agents/:id/versions/:vid (editar rascunho)",
    chamar: async () => {
      const { PATCH } = await import("@/app/api/v1/ai/agents/[id]/versions/[vid]/route");
      return PATCH(req(`/versions/${VERSION}`, "PATCH", { system_prompt: "x" }), {
        params: Promise.resolve({ id: AGENT, vid: VERSION }),
      });
    },
  },
  {
    nome: "POST /agents/:id/publish (publicar)",
    chamar: async () => {
      const { POST } = await import("@/app/api/v1/ai/agents/[id]/publish/route");
      return POST(req("/publish", "POST", { version_id: VERSION }), {
        params: Promise.resolve({ id: AGENT }),
      });
    },
  },
  {
    nome: "POST /agents/:id/versions/:vid/test (testar)",
    chamar: async () => {
      const { POST } = await import("@/app/api/v1/ai/agents/[id]/versions/[vid]/test/route");
      return POST(req(`/versions/${VERSION}/test`, "POST", { sample_message: "oi" }), {
        params: Promise.resolve({ id: AGENT, vid: VERSION }),
      });
    },
  },
];

const PORTAS_DE_LEITURA: Porta[] = [
  {
    nome: "GET /agents/:id",
    chamar: async () => {
      const { GET } = await import("@/app/api/v1/ai/agents/[id]/route");
      return GET(req("", "GET"), { params: Promise.resolve({ id: AGENT }) });
    },
  },
  { nome: "GET /agents/:id/versions/:vid", chamar: () => get({ authorization: "Bearer dsk_abc_def" }) },
];

describe("token que JÁ existe não ganha poder de configuração (decisão do PR #2194)", () => {
  it.each(PORTAS_DE_ESCRITA)("$nome: mcp:write + role:admin → 403", async ({ chamar }) => {
    token({ scopes: ["mcp:read", "mcp:write", "role:admin"], role: "admin" });

    const res = await chamar();

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
    expect(validateBearerToken).toHaveBeenCalled();
    expect(requireRole).not.toHaveBeenCalled();
    // Recusado antes do banco: nada foi lido nem gravado.
    expect(filtros).toEqual([]);
  });

  it.each(PORTAS_DE_LEITURA)("$nome: mcp:read + role:admin → 403", async ({ chamar }) => {
    token({ scopes: ["mcp:read", "mcp:write", "role:admin"], role: "admin" });

    const res = await chamar();

    expect(res.status).toBe(403);
    expect(filtros).toEqual([]);
  });

  it.each(PORTAS_DE_ESCRITA)("$nome: config:write sem papel admin → 403", async ({ chamar }) => {
    token({ scopes: ["config:write", "role:manager"], role: "manager" });

    const res = await chamar();

    expect(res.status).toBe(403);
    expect(filtros).toEqual([]);
  });
});

// A fronteira que a decisão cria: ler NÃO é escrever. O token oferecido na
// tela como "Ler a configuração do agente" não publica, não testa, não edita
// rascunho, não pausa e não arquiva.
describe("config:read não escreve; config:write passa da auth", () => {
  it.each(PORTAS_DE_ESCRITA)("$nome: config:read + role:admin → 403", async ({ chamar }) => {
    token({ scopes: ["config:read", "role:admin"], role: "admin" });

    const res = await chamar();

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_role");
    expect(filtros).toEqual([]);
  });

  it.each(PORTAS_DE_ESCRITA)("$nome: config:write + role:admin passa da auth", async ({ chamar }) => {
    token({ scopes: ["config:write", "role:admin"], role: "admin" });

    const res = await chamar();

    // Depois da auth vem o banco vazio (404) ou a validação do corpo (422):
    // qualquer coisa, menos a porta fechada.
    expect([401, 403]).not.toContain(res.status);
    expect(requireRole).not.toHaveBeenCalled();
  });
});

describe("token NOVO com config:write pausa o agente, e a auditoria nomeia o token", () => {
  it("PATCH paused_at por token → 200, UPDATE na org do token, audit ai_agent.paused com o id do token", async () => {
    token({ scopes: ["config:write", "role:admin"], role: "admin" });
    const gravado: Record<string, unknown>[] = [];
    const existente = { id: AGENT, organization_id: ORG_DO_TOKEN, published_version_id: null, config: {} };
    const n: Record<string, unknown> = {};
    n.from = () => n;
    n.select = () => n;
    n.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return n;
    };
    n.update = (payload: Record<string, unknown>) => {
      gravado.push(payload);
      return n;
    };
    n.maybeSingle = async () => ({ data: existente, error: null });
    n.single = async () => ({ data: { ...existente, ...gravado[0] }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(n as never);

    const res = await PORTAS_DE_ESCRITA[0]!.chamar();

    expect(res.status).toBe(200);
    expect(gravado).toEqual([{ paused_at: "2026-10-05T12:00:00.000Z" }]);
    expect(filtros).toContainEqual(["organization_id", ORG_DO_TOKEN]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_agent.paused",
        actorUserId: null,
        actorApiTokenId: "tok-1",
        organizationId: ORG_DO_TOKEN,
        resourceId: AGENT,
      }),
    );
  });
});
