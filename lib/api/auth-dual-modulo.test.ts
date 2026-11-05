/**
 * `resolveAuthDual` com TOKEN DE MÓDULO (Spec 33, F3, tarefa 3).
 *
 * O que esta suíte prova no ponto único de aplicação:
 *  1. módulo + porta SEM área ⇒ 403 `module_area_not_granted`;
 *  2. consentido só em `contatos.leitura`: `GET /contacts` passa, `POST /contacts` e
 *     `GET /pipelines` dão 403;
 *  3. consentimento retirado entre duas chamadas ⇒ a segunda recusa (nada em cache);
 *  4. a área é conferida ANTES do escopo e do papel (a recusa de área vem mesmo com escopo certo);
 *  5. SEM módulo, nada muda: sessão e token de pessoa/agente não tocam o banco do módulo.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";

import { resolveAuthDual } from "./auth-dual";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ session: true })) }));

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
      c.maybeSingle = async () => ({ data: banco.linhas[tabela] ?? null, error: null });
      return c;
    },
  })),
}));

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
const { validateBearerToken } = await import("@/lib/mcp/auth");

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "aaaaaaaa-1111-4111-8111-111111111111";
const INST = "cccccccc-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const OPCOES = { requestId: "req-1", resource: "contacts", role: "viewer" as const, scope: "mcp:read" };

function req(metodo: string, caminho: string) {
  return new NextRequest(`http://localhost${caminho}`, {
    method: metodo,
    headers: { authorization: "Bearer dsk_abc_def" },
  });
}

function moduloAutenticado(scopes = ["mcp:read", "mcp:write", "role:viewer", "actor:module:acme/comanda"]) {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: "viewer",
    actor: { type: "module", id: TOKEN, slug: "acme/comanda" },
    apiTokenId: TOKEN,
    scopes,
  });
}

function pacote(consentidas: string[]) {
  banco.linhas = {
    api_tokens: { extension_installation_id: INST, module_slug: "acme/comanda", revoked_at: null },
    extension_installations: {
      publisher: "acme",
      name: "comanda",
      disabled_at: null,
      removed_at: null,
      extension_artifacts: {
        manifest: {
          profile: "connected",
          host_api: { min: 2, max: 2 },
          permissions: ["area.contatos.leitura", "area.contatos.escrita", "area.funis.leitura"],
        },
      },
    },
    organization_extensions: { enabled: true, consented_areas: consentidas },
  };
}

async function codigoDe(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

beforeEach(() => {
  vi.clearAllMocks();
  banco.consultas.length = 0;
  banco.linhas = {};
});

describe("resolveAuthDual — token de módulo", () => {
  it("consentido só em contatos.leitura: GET /contacts passa", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura"]);
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts"), OPCOES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.organizationId).toBe(ORG);
      expect(r.actor.type).toBe("module");
      expect(r.via).toBe("token");
    }
  });

  it("consentido só em contatos.leitura: POST /contacts dá 403 (escrita sem permissão de escrita)", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura"]);
    const r = await resolveAuthDual(req("POST", "/api/v1/contacts"), {
      ...OPCOES,
      role: "agent",
      scope: "mcp:write",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await codigoDe(r.response)).toBe("module_area_not_granted");
    }
  });

  it("consentido só em contatos.leitura: GET /pipelines dá 403 (outra área)", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura"]);
    const r = await resolveAuthDual(req("GET", "/api/v1/pipelines"), OPCOES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await codigoDe(r.response)).toBe("module_area_not_granted");
    }
  });

  it("porta SEM área dá 403 mesmo com tudo consentido", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura", "area.contatos.escrita", "area.funis.leitura"]);
    for (const [metodo, caminho] of [
      ["POST", "/api/v1/messages"],
      ["GET", "/api/v1/settings/api-tokens"],
      ["GET", "/api/v1/modulos"],
    ] as const) {
      const r = await resolveAuthDual(req(metodo, caminho), { ...OPCOES, scope: "mcp:write" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(403);
        expect(await codigoDe(r.response)).toBe("module_area_not_granted");
      }
    }
  });

  it("a área vale ANTES do papel: viewer em rota que pede manager recusa por área, não por papel", async () => {
    moduloAutenticado();
    pacote([]);
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts"), { ...OPCOES, role: "manager" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await codigoDe(r.response)).toBe("module_area_not_granted");
  });

  it("com a área concedida, o papel e o escopo continuam valendo (viewer não vira manager)", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura"]);
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts"), { ...OPCOES, role: "manager" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await codigoDe(r.response)).toBe("forbidden_role");
  });

  it("token REAL de módulo (só mcp:read) passa em rota que pede config:read/mcp:write: o escopo vem da área consentida", async () => {
    moduloAutenticado(["mcp:read", "role:viewer", "actor:module:acme/comanda"]);
    pacote(["area.funis.leitura", "area.contatos.escrita"]);
    const leitura = await resolveAuthDual(req("GET", "/api/v1/pipelines"), { ...OPCOES, scope: "config:read" });
    expect(leitura.ok).toBe(true);
    const escrita = await resolveAuthDual(req("POST", "/api/v1/contacts"), { ...OPCOES, scope: "mcp:write" });
    expect(escrita.ok).toBe(true);
  });

  it("sem a área, o escopo ausente não é desculpa nem brecha: recusa por área", async () => {
    moduloAutenticado(["mcp:read", "role:viewer", "actor:module:acme/comanda"]);
    pacote(["area.contatos.leitura"]);
    const r = await resolveAuthDual(req("GET", "/api/v1/pipelines"), { ...OPCOES, scope: "config:read" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await codigoDe(r.response)).toBe("module_area_not_granted");
  });

  it("módulo desligado dá 403 module_disabled", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura"]);
    banco.linhas.organization_extensions = { enabled: false, consented_areas: ["area.contatos.leitura"] };
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts"), OPCOES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await codigoDe(r.response)).toBe("module_disabled");
    }
  });

  it("consentimento retirado entre duas chamadas: a segunda recusa", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura"]);
    const primeira = await resolveAuthDual(req("GET", "/api/v1/contacts"), OPCOES);
    expect(primeira.ok).toBe(true);

    pacote([]);
    const segunda = await resolveAuthDual(req("GET", "/api/v1/contacts"), OPCOES);
    expect(segunda.ok).toBe(false);
    if (!segunda.ok) expect(await codigoDe(segunda.response)).toBe("module_area_not_granted");
  });

  it("`portaModelo` da rota vale mais que o caminho", async () => {
    moduloAutenticado();
    pacote(["area.contatos.leitura"]);
    const r = await resolveAuthDual(req("GET", "/api/v1/contacts"), {
      ...OPCOES,
      portaModelo: "/api/v1/messages",
    });
    expect(r.ok).toBe(false);
  });
});

describe("resolveAuthDual — sem módulo, nada muda", () => {
  it("token de agente e token de servidor não consultam o banco do módulo", async () => {
    pacote([]); // se fosse consultado, recusaria
    for (const actor of [
      { type: "ai_agent", id: "run-1", role: "agent", api_token_id: "tok-1" },
      { type: "api_token", id: "tok-2", role: "agent" },
    ] as const) {
      vi.mocked(validateBearerToken).mockResolvedValue({
        organizationId: ORG,
        role: "agent",
        actor,
        apiTokenId: "tok",
        scopes: ["mcp:read", "mcp:write"],
      });
      const r = await resolveAuthDual(req("POST", "/api/v1/messages"), {
        ...OPCOES,
        resource: "messages",
        role: "agent",
        scope: "mcp:write",
      });
      expect(r.ok).toBe(true);
    }
    expect(banco.consultas).toEqual([]);
  });

  it("sessão de navegador não consulta o banco do módulo", async () => {
    const user = {
      id: USER_ID,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
    } as AuthUser;
    vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, role: "agent" } } as never);
    const r = await resolveAuthDual(
      new NextRequest("http://localhost/api/v1/contacts", { method: "GET" }),
      OPCOES,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe("session");
    expect(banco.consultas).toEqual([]);
  });
});
