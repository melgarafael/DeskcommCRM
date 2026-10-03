/**
 * Criar roteiro de atendimento (`surface: "atendimento"`) só existe com o módulo
 * `fluxos_atendimento` ligado na instalação (doc 64). Desligado, a porta não
 * existe: 404, sem tocar no banco da organização — a mesma resposta do banco
 * externo desligado. O follow-up comum não consulta a chave.
 *
 * Também prova a dualidade de auth (sessão OU Bearer dsk_, issue #1875): no ramo
 * do token a org sai da LINHA DO TOKEN e nunca do body/query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  client: vi.fn(),
  modulo: vi.fn(),
  admin: vi.fn(),
  validateBearerToken: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: deps.validateBearerToken };
});
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.checkRateLimit }));

import { GET, POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_DO_TOKEN = "99999999-9999-4999-8999-999999999999";

function clientFake() {
  const capturado: { payload?: Record<string, unknown> } = {};
  const client = {
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        capturado.payload = payload;
        return {
          select: () => ({
            single: async () => ({ data: { id: "novo", status: "draft", ...payload }, error: null }),
          }),
        };
      },
    }),
  };
  return { capturado, client };
}

/** Client de LISTAGEM (GET) — decorre `from(...).select().eq().neq().order()`. */
function clientDaLista() {
  const filtros: Array<[string, string, unknown]> = [];
  const cadeia = {
    select: () => cadeia,
    eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), cadeia),
    neq: (c: string, v: unknown) => (filtros.push(["neq", c, v]), cadeia),
    order: async () => ({ data: [], error: null }),
  };
  return { filtros, client: { from: () => cadeia } };
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/followup-flows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tokenReq(body: unknown, scopes: string[], role = "admin") {
  const { validateBearerToken } = deps;
  void validateBearerToken;
  return {
    request: new NextRequest("http://localhost/api/v1/ai/followup-flows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dsk_abc",
      },
      body: JSON.stringify(body),
    }),
    token: {
      organizationId: ORG_DO_TOKEN,
      scopes,
      role,
      actor: { type: "api_token", id: "tok-1" },
      apiTokenId: "tok-1",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.admin.mockReturnValue({});
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "eu", idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  deps.checkRateLimit.mockResolvedValue({ allowed: true });
});

describe("POST /api/v1/ai/followup-flows — roteiro de atendimento", () => {
  it("módulo desligado: 404 e nada é gravado", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);
    deps.modulo.mockResolvedValue(false);

    const res = await POST(req({ name: "Cadastro", surface: "atendimento" }));
    expect(res.status).toBe(404);
    expect(capturado.payload).toBeUndefined();
    expect(deps.modulo).toHaveBeenCalledWith(expect.anything(), "fluxos_atendimento");
  });

  it("módulo ligado: cria o roteiro com a superfície gravada", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);
    deps.modulo.mockResolvedValue(true);

    const res = await POST(req({ name: "Cadastro", surface: "atendimento" }));
    expect(res.status).toBe(201);
    expect(capturado.payload).toMatchObject({ organization_id: ORG, surface: "atendimento" });
  });

  it("follow-up comum não consulta a chave nem grava superfície", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ name: "Retomada" }));
    expect(res.status).toBe(201);
    expect(deps.modulo).not.toHaveBeenCalled();
    expect(capturado.payload).not.toHaveProperty("surface");
  });
});

describe("GET /api/v1/ai/followup-flows — roteiros fora da lista de follow-ups", () => {
  it("sem parâmetro: só fluxos do relógio (a prova achou roteiros na tela de Follow-ups)", async () => {
    const { filtros, client } = clientDaLista();
    deps.client.mockResolvedValue(client);
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/followup-flows"));
    expect(res.status).toBe(200);
    expect(filtros).toContainEqual(["neq", "surface", "atendimento"]);
  });

  it("?surface=atendimento: só os roteiros", async () => {
    const { filtros, client } = clientDaLista();
    deps.client.mockResolvedValue(client);
    await GET(new NextRequest("http://localhost/api/v1/ai/followup-flows?surface=atendimento"));
    expect(filtros).toContainEqual(["eq", "surface", "atendimento"]);
    expect(filtros).not.toContainEqual(["neq", "surface", "atendimento"]);
  });

  it("GET: com Bearer mcp:read, requireRole (sessão) não é consultado — org vem do token", async () => {
    const { filtros, client } = clientDaLista();
    // Ramo do token usa createAdminClient() (não a sessão de navegador).
    deps.admin.mockReturnValue(client);
    deps.validateBearerToken.mockResolvedValue({
      organizationId: ORG_DO_TOKEN,
      scopes: ["mcp:read", "mcp:write"],
      role: "admin",
      actor: { type: "api_token", id: "tok-1" },
      apiTokenId: "tok-1",
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/v1/ai/followup-flows?organization_id=11111111", {
        headers: { authorization: "Bearer dsk_abc" },
      }),
    );
    expect(res.status).toBe(200);
    expect(deps.role).not.toHaveBeenCalled();
    expect(deps.client).not.toHaveBeenCalled();
    expect(deps.admin).toHaveBeenCalled();
    // O client do token é o admin (sem RLS): o filtro de org é a ÚNICA cerca.
    expect(filtros).toContainEqual(["eq", "organization_id", ORG_DO_TOKEN]);
  });
});

describe("auth-dual (issue #1875) — Bearer token nas portas de follow-up", () => {
  it("POST: admin com mcp:write cria — requireRole (sessão) não é consultado", async () => {
    const { capturado, client } = clientFake();
    deps.admin.mockReturnValue(client); // o insert do token cai no admin client
    const { request, token } = tokenReq({ name: "Via API" }, ["mcp:read", "mcp:write"]);
    deps.validateBearerToken.mockResolvedValue(token as never);

    const res = await POST(request);
    expect(res.status).toBe(201);
    expect(capturado.payload).toMatchObject({ organization_id: ORG_DO_TOKEN, name: "Via API" });
    expect(deps.role).not.toHaveBeenCalled();
  });

  it("token de leitura (só mcp:read) numa escrita manager é recusado com 403", async () => {
    deps.admin.mockReturnValue(clientFake().client);
    const { request, token } = tokenReq({ name: "Via API" }, ["mcp:read"]);
    deps.validateBearerToken.mockResolvedValue(token as never);

    const res = await POST(request);
    expect(res.status).toBe(403);
    expect(deps.role).not.toHaveBeenCalled();
  });

  it("token com papel abaixo de manager é recusado com 403, mesmo com mcp:write", async () => {
    deps.admin.mockReturnValue(clientFake().client);
    const { request, token } = tokenReq({ name: "Via API" }, ["mcp:read", "mcp:write"], "agent");
    deps.validateBearerToken.mockResolvedValue(token as never);

    const res = await POST(request);
    expect(res.status).toBe(403);
  });

  it("sem sessão nem Bearer → requireRole (sessão) responde 401 antes do efeito", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await POST(req({ name: "Sessão vencida" }));
    expect(res.status).toBe(401);
  });
});