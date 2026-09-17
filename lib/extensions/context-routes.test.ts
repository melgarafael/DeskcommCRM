import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  list: vi.fn(),
  guide: vi.fn(),
  configure: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(),
  sessionAal: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/extensions/service", () => ({
  listExtensions: mocks.list,
  loadExtensionGuide: mocks.guide,
  configureExtension: mocks.configure,
  readExtensionOperation: mocks.receipt,
  canManageInstallation: async () => false,
}));

import { GET as list } from "@/app/api/v1/extensions/route";
import { GET as guide } from "@/app/api/v1/extensions/[id]/route";
import { PUT as configure } from "@/app/api/v1/extensions/[id]/configuration/route";
import { POST as open } from "@/app/api/v1/extensions/[id]/open/route";
import { GET as receipt } from "@/app/api/v1/extensions/operations/[id]/route";

const ORGANIZATION_A = "a0000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "b0000000-0000-4000-8000-000000000002";
const ACTOR = "c0000000-0000-4000-8000-000000000003";
const INSTALLATION = "d0000000-0000-4000-8000-000000000004";
const OPERATION = "e0000000-0000-4000-8000-000000000005";
const configuration = {
  expected_revision: 0,
  enabled: true,
  configuration: { density: "compact", show_description: false },
};

function request(method: string, expectedOrganization?: string, body?: unknown): Request {
  const headers = new Headers({ "Idempotency-Key": OPERATION });
  if (expectedOrganization !== undefined) {
    headers.set("X-Expected-Organization-Id", expectedOrganization);
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request("http://localhost/api/v1/extensions", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const routes: Array<{
  name: string;
  call: (expectedOrganization?: string) => Promise<Response>;
}> = [
  {
    name: "lista",
    // Request é parte do contrato HTTP; cast permite provar a falha anterior,
    // cuja função ignorava integralmente esse argumento.
    call: (org) => (list as (request: Request) => Promise<Response>)(request("GET", org)),
  },
  {
    name: "guia",
    call: (org) => guide(request("GET", org), { params: Promise.resolve({ id: INSTALLATION }) }),
  },
  {
    name: "configuração",
    call: (org) =>
      configure(request("PUT", org, configuration), {
        params: Promise.resolve({ id: INSTALLATION }),
      }),
  },
  {
    name: "abertura de Tarefas",
    call: (org) =>
      open(request("POST", org, { capability: "tasks.open", expected_revision: 0, card_id: "prioridades" }), {
        params: Promise.resolve({ id: INSTALLATION }),
      }),
  },
  {
    name: "recibo",
    call: (org) => receipt(request("GET", org), { params: Promise.resolve({ id: OPERATION }) }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockResolvedValue({
    ok: true,
    user: { id: ACTOR, idioma: "pt-BR", is_platform_admin: false, support: null },
    org: { orgId: ORGANIZATION_B, role: "admin" },
  });
  mocks.list.mockResolvedValue({ organization_id: ORGANIZATION_B });
  mocks.guide.mockResolvedValue({ organization_id: ORGANIZATION_B, revision: 0 });
  mocks.configure.mockResolvedValue({ id: OPERATION, organization_id: ORGANIZATION_B });
  mocks.receipt.mockResolvedValue({ id: OPERATION, organization_id: ORGANIZATION_B });
});

function expectNoEffectOrRead(): void {
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.guide).not.toHaveBeenCalled();
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.receipt).not.toHaveBeenCalled();
}

describe("contexto exibido pela extensão e cookie compartilhado entre abas", () => {
  it.each(routes)("$name recusa A apresentada quando cookie já aponta para B", async ({ call }) => {
    const response = await call(ORGANIZATION_A);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("extension_context_changed");
    expectNoEffectOrRead();
  });

  it.each(routes)("$name exige uma precondição explícita", async ({ call }) => {
    const response = await call();
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_failed");
    expectNoEffectOrRead();
  });

  it("precondição malformada não escolhe organização nem consulta o serviço", async () => {
    const response = await routes[0]!.call("b0000000-0000-4000-8000-000000000002,other");
    expect(response.status).toBe(400);
    expectNoEffectOrRead();
  });

  it("configura a organização canônica quando o contexto coincide", async () => {
    const response = await routes[2]!.call(ORGANIZATION_B);
    expect(response.status).toBe(200);
    expect(mocks.configure).toHaveBeenCalledWith(
      ACTOR,
      ORGANIZATION_B,
      INSTALLATION,
      OPERATION,
      configuration,
    );
    expect((await response.json()).data.organization_id).toBe(ORGANIZATION_B);
  });

  it("organização no corpo não substitui a autoridade do cookie", async () => {
    const response = await configure(
      request("PUT", ORGANIZATION_B, { ...configuration, organization_id: ORGANIZATION_A }),
      { params: Promise.resolve({ id: INSTALLATION }) },
    );
    expect(response.status).toBe(422);
    expectNoEffectOrRead();
  });

  it("abertura confere que o card existe na versão vigente", async () => {
    const card = (id: string) => ({ id, action: { capability: "tasks.open" } });
    mocks.guide.mockResolvedValue({
      organization_id: ORGANIZATION_B,
      revision: 2,
      manifest: { contributions: { crm_cards: [card("prioridades")] } },
    });
    const abrir = (cardId: string) =>
      open(request("POST", ORGANIZATION_B, { capability: "tasks.open", expected_revision: 2, card_id: cardId }), {
        params: Promise.resolve({ id: INSTALLATION }),
      });

    const existente = await abrir("prioridades");
    expect(existente.status).toBe(200);
    expect((await existente.json()).data).toEqual({ href: "/app/tasks" });

    // Uma aba aberta antes de uma troca de versão pede um card que a versão vigente não tem.
    const ausente = await abrir("card-que-saiu");
    expect(ausente.status).toBe(409);
    expect((await ausente.json()).error.code).toBe("extension_card_unavailable");
  });

  it("o guard de papel precede o contexto informado pelo cliente", async () => {
    mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const response = await routes[2]!.call(ORGANIZATION_B);
    expect(response.status).toBe(403);
    expectNoEffectOrRead();
  });
});
