/**
 * `resolveAuthDual` com TOKEN DE MÓDULO + JWT de contexto (Spec 33, F3, tarefa 4).
 *
 * Prova, com o JWT REAL (ES256) e só o banco substituído:
 *  - papel efetivo = min(teto `manager`, papel ATUAL da pessoa); `admin` nunca;
 *  - sem JWT: teto `agent` e nunca acima do papel do token;
 *  - pessoa rebaixada entre duas chamadas perde o poder na seguinte (nada em cache);
 *  - pessoa removida da organização, JWT de outra organização/instalação, vencido, de outra chave,
 *    ou sem chave configurada ⇒ 403 `module_context_invalid`;
 *  - escrita de módulo com acompanhamento de suporte restrito ⇒ 403;
 *  - sem token de módulo, o cabeçalho `X-Module-Context` não muda nada.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitirJwtDeContexto } from "@/lib/modulo/jwt-de-contexto";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";

import { resolveAuthDual } from "./auth-dual";

const h = vi.hoisted(() => ({ pem: "" }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/impersonate/support", () => ({ supportCallbackWriteAllowed: vi.fn(async () => true) }));

const banco = vi.hoisted(() => ({
  linhas: {} as Record<string, Record<string, unknown> | null>,
  consultas: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from(tabela: string) {
      banco.consultas.push(tabela);
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: banco.linhas[tabela] ?? null, error: null });
      return c;
    },
  })),
}));

vi.mock("@/lib/modulo/jwt-de-contexto", async () => {
  const actual = await vi.importActual<typeof import("@/lib/modulo/jwt-de-contexto")>(
    "@/lib/modulo/jwt-de-contexto",
  );
  return {
    ...actual,
    verificarJwtDeContexto: (jwt: string, esperado: Parameters<typeof actual.verificarJwtDeContexto>[1]) =>
      actual.verificarJwtDeContexto(jwt, { chavePem: h.pem, ...esperado }),
  };
});

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");

function novaChavePem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
h.pem = novaChavePem();

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const TOKEN = "aaaaaaaa-1111-4111-8111-111111111111";
const INST = "cccccccc-3333-4333-8333-333333333333";
const PESSOA = "11111111-1111-4111-8111-111111111111";

async function jwt(extra: { organizationId?: string; installationId?: string; chavePem?: string; agora?: Date } = {}) {
  const r = await emitirJwtDeContexto({
    pessoaId: PESSOA,
    organizationId: extra.organizationId ?? ORG,
    installationId: extra.installationId ?? INST,
    chavePem: extra.chavePem ?? h.pem,
    agora: extra.agora,
  });
  return r!.jwt;
}

function req(metodo: string, caminho: string, contexto?: string) {
  return new NextRequest(`http://localhost${caminho}`, {
    method: metodo,
    headers: {
      authorization: "Bearer dsk_abc_def",
      ...(contexto !== undefined ? { "x-module-context": contexto } : {}),
    },
  });
}

function moduloAutenticado(papelDoToken: "viewer" | "manager" = "viewer") {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: papelDoToken,
    actor: { type: "module", id: TOKEN, slug: "acme/comanda" },
    apiTokenId: TOKEN,
    scopes: ["mcp:read", "mcp:write", `role:${papelDoToken}`, "actor:module:acme/comanda"],
  });
}

function pacote(papelDaPessoa: string | null) {
  banco.linhas = {
    api_tokens: { extension_installation_id: INST, module_slug: "acme/comanda", revoked_at: null },
    extension_installations: {
      publisher: "acme",
      name: "comanda",
      disabled_at: null,
      removed_at: null,
      extension_artifacts: {
        manifest: { profile: "connected", host_api: { min: 2, max: 2 }, permissions: ["area.contatos.leitura", "area.contatos.escrita"] },
      },
    },
    organization_extensions: {
      enabled: true,
      consented_areas: ["area.contatos.leitura", "area.contatos.escrita"],
    },
    user_organizations: papelDaPessoa ? { role: papelDaPessoa } : null,
  };
}

const LEITURA = { requestId: "r", resource: "contacts", scope: "mcp:read", role: "viewer" } as const;

async function codigoDe(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function recusa(r: Awaited<ReturnType<typeof resolveAuthDual>>, codigo: string) {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.response.status).toBe(403);
    expect(await codigoDe(r.response)).toBe(codigo);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supportCallbackWriteAllowed).mockResolvedValue(true);
  banco.consultas.length = 0;
  banco.linhas = {};
  h.pem = h.pem || novaChavePem();
});

describe("papel efetivo do módulo com JWT de contexto", () => {
  it("pessoa manager: a rota que pede manager passa, e a pessoa vem no resultado", async () => {
    moduloAutenticado();
    pacote("manager");
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), { ...LEITURA, role: "manager" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pessoaDoModulo).toBe(PESSOA);
      // A pessoa também viaja no ator, para o audit gravar `metadata.person_id` sem tocar as rotas.
      expect(r.actor).toMatchObject({ type: "module", pessoaId: PESSOA });
    }
  });

  it("pessoa admin vira manager: rota que pede admin recusa (admin NUNCA)", async () => {
    moduloAutenticado();
    pacote("admin");
    const manager = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), { ...LEITURA, role: "manager" });
    expect(manager.ok).toBe(true);
    const admin = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), { ...LEITURA, role: "admin" });
    await recusa(admin, "forbidden_role");
  });

  it("teto manager vale também para o `tokenRole` da rota", async () => {
    moduloAutenticado();
    pacote("admin");
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), {
      ...LEITURA,
      role: "viewer",
      tokenRole: "admin",
    });
    await recusa(r, "forbidden_role");
  });

  it("pessoa agent: passa onde pede agent e recusa onde pede manager", async () => {
    moduloAutenticado();
    pacote("agent");
    const agent = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), { ...LEITURA, role: "agent" });
    expect(agent.ok).toBe(true);
    const manager = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), { ...LEITURA, role: "manager" });
    await recusa(manager, "forbidden_role");
  });

  it("pessoa rebaixada entre duas chamadas: a segunda perde o poder (papel lido do banco, não do JWT)", async () => {
    moduloAutenticado();
    const mesmoJwt = await jwt();
    pacote("manager");
    const primeira = await resolveAuthDual(req("GET", "/api/v1/contacts", mesmoJwt), { ...LEITURA, role: "manager" });
    expect(primeira.ok).toBe(true);

    pacote("viewer");
    const segunda = await resolveAuthDual(req("GET", "/api/v1/contacts", mesmoJwt), { ...LEITURA, role: "manager" });
    await recusa(segunda, "forbidden_role");
  });

  it("pessoa REMOVIDA da organização com JWT ainda válido: 403 module_context_invalid", async () => {
    moduloAutenticado();
    pacote(null);
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), LEITURA);
    await recusa(r, "module_context_invalid");
  });
});

describe("sem JWT de contexto", () => {
  it("teto agent: token manager sem pessoa não passa de agent", async () => {
    moduloAutenticado("manager");
    pacote("admin"); // não é lida: sem JWT não há pessoa
    const agent = await resolveAuthDual(req("GET", "/api/v1/contacts"), { ...LEITURA, role: "agent" });
    expect(agent.ok).toBe(true);
    const manager = await resolveAuthDual(req("GET", "/api/v1/contacts"), { ...LEITURA, role: "manager" });
    await recusa(manager, "forbidden_role");
    expect(banco.consultas).not.toContain("user_organizations");
  });

  it("nunca acima do papel do token: viewer sem pessoa não vira agent", async () => {
    moduloAutenticado("viewer");
    pacote("admin");
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts"), { ...LEITURA, role: "agent" });
    await recusa(r, "forbidden_role");
  });
});

describe("JWT que não vale", () => {
  it.each([
    ["de outra organização", () => jwt({ organizationId: OUTRA_ORG })],
    ["de outra instalação", () => jwt({ installationId: randomUUID() })],
    ["vencido", () => jwt({ agora: new Date(Date.now() - 3600_000) })],
    ["assinado por outra chave", () => jwt({ chavePem: novaChavePem() })],
    ["lixo", async () => "isto-nao-e-jwt"],
    ["vazio", async () => ""],
  ])("%s ⇒ 403 module_context_invalid, sem ler papel", async (_nome, fazer) => {
    moduloAutenticado();
    pacote("admin");
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts", await fazer()), LEITURA);
    await recusa(r, "module_context_invalid");
    expect(banco.consultas).not.toContain("user_organizations");
  });

  it("chave do host não configurada: cabeçalho presente recusa (nunca ignora em silêncio)", async () => {
    moduloAutenticado();
    pacote("manager");
    const valido = await jwt();
    const guardada = h.pem;
    h.pem = "";
    try {
      const r = await resolveAuthDual(req("GET", "/api/v1/contacts", valido), LEITURA);
      await recusa(r, "module_context_invalid");
    } finally {
      h.pem = guardada;
    }
  });

  it("a recusa de área vem ANTES do JWT: porta sem área nem lê o contexto", async () => {
    moduloAutenticado();
    pacote("manager");
    const r = await resolveAuthDual(req("GET", "/api/v1/settings/api-tokens", await jwt()), LEITURA);
    await recusa(r, "module_area_not_granted");
    expect(banco.consultas).not.toContain("user_organizations");
  });
});

describe("acompanhamento de suporte", () => {
  const ESCRITA = { requestId: "r", resource: "contacts", scope: "mcp:write", role: "agent" } as const;

  it("escrita de módulo com acompanhamento restrito ⇒ 403, e a pessoa do JWT é a consultada", async () => {
    moduloAutenticado();
    pacote("manager");
    vi.mocked(supportCallbackWriteAllowed).mockResolvedValue(false);
    const r = await resolveAuthDual(req("POST", "/api/v1/contacts", await jwt()), ESCRITA);
    await recusa(r, "forbidden");
    expect(supportCallbackWriteAllowed).toHaveBeenCalledWith(ORG, PESSOA);
  });

  it("escrita sem JWT também é consultada (sem pessoa: qualquer restrição da organização barra)", async () => {
    moduloAutenticado("manager");
    pacote(null);
    vi.mocked(supportCallbackWriteAllowed).mockResolvedValue(false);
    const r = await resolveAuthDual(req("POST", "/api/v1/contacts"), ESCRITA);
    await recusa(r, "forbidden");
    expect(supportCallbackWriteAllowed).toHaveBeenCalledWith(ORG, undefined);
  });

  it("leitura não é barrada nem consulta o suporte", async () => {
    moduloAutenticado();
    pacote("manager");
    vi.mocked(supportCallbackWriteAllowed).mockResolvedValue(false);
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts", await jwt()), LEITURA);
    expect(r.ok).toBe(true);
    expect(supportCallbackWriteAllowed).not.toHaveBeenCalled();
  });

  it("sem acompanhamento restrito, a escrita de pessoa agent com JWT passa", async () => {
    moduloAutenticado();
    pacote("agent");
    const r = await resolveAuthDual(req("POST", "/api/v1/contacts", await jwt()), ESCRITA);
    expect(r.ok).toBe(true);
  });
});

describe("sem token de módulo, o cabeçalho não muda nada", () => {
  it("token de servidor com X-Module-Context torto passa como antes e não toca o banco", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: ORG,
      role: "manager",
      actor: { type: "api_token", id: "tok", role: "manager" },
      apiTokenId: "tok",
      scopes: ["mcp:read", "role:manager"],
    });
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts", "lixo"), { ...LEITURA, role: "manager" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pessoaDoModulo).toBeUndefined();
    expect(banco.consultas).toEqual([]);
    expect(supportCallbackWriteAllowed).not.toHaveBeenCalled();
  });
});
