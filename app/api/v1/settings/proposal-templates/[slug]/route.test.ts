// app/api/v1/settings/proposal-templates/[slug]/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mocks: Record<string, any> = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  createAdminClient: vi.fn(),
  audit: vi.fn(),
  traduzir: vi.fn((txt: string) => txt),
}));

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: mocks.traduzir }));
// `resolveAuthDual` (ramo de sessão) cria o cliente de sessão; o token não é usado aqui.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));

import { DELETE, GET, PATCH } from "./route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

interface MundoOpts {
  papel?: keyof typeof ROLE_RANK;
  copiaAtiva?: Record<string, unknown> | null;
  maiorVersao?: number | null;
}

function montarMundo(opts: MundoOpts = {}) {
  const papel = opts.papel ?? "manager";
  const rank = ROLE_RANK[papel] ?? 0;
  mocks.requireRole.mockImplementation(async (minRole: keyof typeof ROLE_RANK) => {
    const minRank = ROLE_RANK[minRole] ?? 0;
    return rank < minRank
      ? { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) }
      : { ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG_ID } };
  });
  mocks.requireSupportWrite.mockResolvedValue(null);

  let atualizado: Record<string, unknown> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cadeia: any = {};
  cadeia.select = () => cadeia;
  cadeia.eq = () => cadeia;
  cadeia.order = () => {
    cadeia.ordenou = true;
    return cadeia;
  };
  cadeia.limit = () => cadeia;
  cadeia.maybeSingle = async () => {
    if (cadeia.ordenou) {
      cadeia.ordenou = false;
      return { data: opts.maiorVersao == null ? null : { version: opts.maiorVersao }, error: null };
    }
    return { data: opts.copiaAtiva ?? null, error: null };
  };
  cadeia.update = (payload: Record<string, unknown>) => {
    atualizado = payload;
    return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
  };

  const admin = { from: vi.fn(() => cadeia) };
  mocks.createAdminClient.mockReturnValue(admin);

  return { atualizado: () => atualizado };
}

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const corpo = (res: Response) => res.json() as Promise<{ data?: Record<string, unknown>; error?: { message?: string } }>;

const COPIA = {
  id: "copia-1",
  slug: "ecommerce",
  nome: "E-commerce nosso",
  descricao: null,
  version: 1,
  sections: [{ id: "summary", title: "Resumo", body: "Texto.", required: true, conditional: false }],
  section_order: ["summary"],
};

function patchValido() {
  return new Request("http://x", {
    method: "PATCH",
    body: JSON.stringify({
      nome: "E-commerce nosso  ",
      descricao: null,
      sections: [{ id: "summary", title: "Resumo", body: "Texto novo.", required: true, conditional: false }],
      section_order: ["summary"],
    }),
  });
}

describe("GET /api/v1/settings/proposal-templates/[slug]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("slug da plataforma sem cópia → origem plataforma e as seções do código", async () => {
    montarMundo({ papel: "viewer", copiaAtiva: null });
    const res = await GET(new Request("http://x") as never, ctx("ecommerce"));
    expect(res.status).toBe(200);
    expect(await corpo(res)).toMatchObject({ data: { origem: "plataforma" } });
  });

  it("slug inexistente → 404", async () => {
    montarMundo({ papel: "viewer", copiaAtiva: null });
    const res = await GET(new Request("http://x") as never, ctx("nao_existe"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v1/settings/proposal-templates/[slug]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sem cópia ativa → 409", async () => {
    const mundo = montarMundo({ copiaAtiva: null });
    const res = await PATCH(patchValido() as never, ctx("ecommerce"));
    expect(res.status).toBe(409);
    expect(mundo.atualizado()).toBeUndefined();
  });

  it("válido → update com version = maior + 1 e nome aparado", async () => {
    const mundo = montarMundo({ copiaAtiva: COPIA, maiorVersao: 4 });
    const res = await PATCH(patchValido() as never, ctx("ecommerce"));
    expect(res.status).toBe(200);
    expect(mundo.atualizado()).toMatchObject({ version: 5, nome: "E-commerce nosso" });
  });

  it("com {{ sem fechar → 422 e nenhum update", async () => {
    const mundo = montarMundo({ copiaAtiva: COPIA });
    const req = new Request("http://x", {
      method: "PATCH",
      body: JSON.stringify({
        nome: "E-commerce nosso",
        descricao: null,
        sections: [{ id: "summary", title: "Resumo", body: "Texto {{project.name", required: true, conditional: false }],
        section_order: ["summary"],
      }),
    });
    const res = await PATCH(req as never, ctx("ecommerce"));
    expect(res.status).toBe(422);
    expect(mundo.atualizado()).toBeUndefined();
  });

  it("como agent → 403", async () => {
    montarMundo({ papel: "agent", copiaAtiva: COPIA });
    const res = await PATCH(patchValido() as never, ctx("ecommerce"));
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/settings/proposal-templates/[slug]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("como agent → 403", async () => {
    montarMundo({ papel: "agent", copiaAtiva: COPIA });
    const res = await DELETE(new Request("http://x") as never, ctx("ecommerce"));
    expect(res.status).toBe(403);
  });

  it("desativa a cópia com is_active: false", async () => {
    const mundo = montarMundo({ copiaAtiva: COPIA });
    const res = await DELETE(new Request("http://x") as never, ctx("ecommerce"));
    expect(res.status).toBe(200);
    expect(mundo.atualizado()).toMatchObject({ is_active: false });
  });
});
