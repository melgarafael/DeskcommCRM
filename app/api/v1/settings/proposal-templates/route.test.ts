// app/api/v1/settings/proposal-templates/route.test.ts
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

import { GET, POST } from "./route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

interface MundoOpts {
  papel?: keyof typeof ROLE_RANK;
  /** linhas ativas devolvidas à listagem (await direto da cadeia) */
  ativas?: Array<Record<string, unknown>>;
  /** cópia ativa devolvida ao `.maybeSingle()` sem `order` */
  copiaAtiva?: Record<string, unknown> | null;
  /** maior versão devolvida ao `.maybeSingle()` com `order` */
  maiorVersao?: number | null;
  /** settings devolvidos à leitura de organizations (merge de modelos_ocultos) */
  settings?: unknown;
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

  let inserido: Record<string, unknown> | undefined;
  let atualizado: Record<string, unknown> | undefined;
  let tabela = "";
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
    if (tabela === "organizations") {
      return { data: opts.settings === undefined ? null : { settings: opts.settings }, error: null };
    }
    if (cadeia.ordenou) {
      cadeia.ordenou = false;
      return { data: opts.maiorVersao == null ? null : { version: opts.maiorVersao }, error: null };
    }
    return { data: opts.copiaAtiva ?? null, error: null };
  };
  cadeia.insert = (linha: Record<string, unknown>) => {
    inserido = linha;
    return Promise.resolve({ error: null });
  };
  cadeia.update = (linha: Record<string, unknown>) => {
    atualizado = linha;
    return cadeia;
  };
  cadeia.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve({ data: opts.ativas ?? [], error: null }).then(resolve);

  const admin = { from: vi.fn((nome: string) => {
    tabela = nome;
    return cadeia;
  }) };
  mocks.createAdminClient.mockReturnValue(admin);

  return { capturado: () => inserido, atualizado: () => atualizado };
}

const corpo = (res: Response) => res.json() as Promise<{ data?: unknown; error?: { code?: string; message?: string } }>;

describe("GET /api/v1/settings/proposal-templates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("como viewer devolve 8 itens quando o banco não tem cópia", async () => {
    montarMundo({ papel: "viewer" });
    const res = await GET(new Request("http://x") as never);
    expect(res.status).toBe(200);
    expect(((await corpo(res)).data as unknown[])).toHaveLength(8);
  });
});

describe("POST /api/v1/settings/proposal-templates", () => {
  beforeEach(() => vi.clearAllMocks());

  function post(payload: unknown) {
    return new Request("http://x", { method: "POST", body: JSON.stringify(payload) });
  }

  it("personalizar como agent → 403 e nenhum insert", async () => {
    const mundo = montarMundo({ papel: "agent" });
    const res = await POST(post({ acao: "personalizar", base_slug: "ecommerce" }) as never);
    expect(res.status).toBe(403);
    expect(mundo.capturado()).toBeUndefined();
  });

  it("personalizar slug que não é da plataforma → 404", async () => {
    const mundo = montarMundo();
    const res = await POST(post({ acao: "personalizar", base_slug: "imobiliaria" }) as never);
    expect(res.status).toBe(404);
    expect(mundo.capturado()).toBeUndefined();
  });

  it("personalizar modelo já personalizado → 409 e nenhum insert", async () => {
    const mundo = montarMundo({ copiaAtiva: { id: "c1" } });
    const res = await POST(post({ acao: "personalizar", base_slug: "ecommerce" }) as never);
    expect(res.status).toBe(409);
    expect(mundo.capturado()).toBeUndefined();
  });

  it("personalizar depois de cópia desativada com version 2 → insert com version 3", async () => {
    const mundo = montarMundo({ copiaAtiva: null, maiorVersao: 2 });
    const res = await POST(post({ acao: "personalizar", base_slug: "ecommerce" }) as never);
    expect(res.status).toBe(200);
    expect(mundo.capturado()).toMatchObject({ slug: "ecommerce", version: 3 });
  });

  it("novo com nome → insert com slug da empresa, base nula e a seção inicial", async () => {
    const mundo = montarMundo();
    const res = await POST(post({ acao: "novo", nome: "Locação por Temporada" }) as never);
    expect(res.status).toBe(200);
    expect(((await corpo(res)).data as { slug: string }).slug).toBe("empresa_locacao_por_temporada");
    expect(mundo.capturado()).toMatchObject({
      slug: "empresa_locacao_por_temporada",
      base_slug: null,
      nome: "Locação por Temporada",
    });
    expect((mundo.capturado()?.sections as unknown[])).toHaveLength(1);
  });

  it("novo com seções inválidas (id repetido) → 422 com details.erros e nenhum insert", async () => {
    const mundo = montarMundo();
    const secao = (id: string) => ({ id, title: `T ${id}`, body: "Texto.", required: true, conditional: false });
    const res = await POST(
      post({ acao: "novo", nome: "Locação", sections: [secao("a"), secao("a")], section_order: ["a", "a"] }) as never,
    );
    expect(res.status).toBe(422);
    const json = await corpo(res);
    expect(JSON.stringify(json)).toContain("erros");
    expect(mundo.capturado()).toBeUndefined();
  });

  it("ocultar como agent → 403 e nenhum update", async () => {
    const mundo = montarMundo({ papel: "agent" });
    const res = await POST(post({ acao: "ocultar", slug: "ecommerce" }) as never);
    expect(res.status).toBe(403);
    expect(mundo.atualizado()).toBeUndefined();
  });

  it("ocultar slug fora do catálogo → 422 e nenhum update", async () => {
    const mundo = montarMundo();
    const res = await POST(post({ acao: "ocultar", slug: "empresa_locacao" }) as never);
    expect(res.status).toBe(422);
    expect(mundo.atualizado()).toBeUndefined();
  });

  it("ocultar faz merge: não apaga enabled nem outras chaves de settings", async () => {
    const mundo = montarMundo({
      settings: {
        outra_chave: 1,
        proposals: { enabled: true, default_valid_days: 15, modelos_ocultos: ["ecommerce"] },
      },
    });
    const res = await POST(post({ acao: "ocultar", slug: "site_institucional" }) as never);
    expect(res.status).toBe(200);
    expect(mundo.atualizado()).toEqual({
      settings: {
        outra_chave: 1,
        proposals: {
          enabled: true,
          default_valid_days: 15,
          modelos_ocultos: ["ecommerce", "site_institucional"],
        },
      },
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal_template.hidden" }));
  });

  it("ocultar slug já oculto não duplica", async () => {
    const mundo = montarMundo({ settings: { proposals: { modelos_ocultos: ["ecommerce"] } } });
    const res = await POST(post({ acao: "ocultar", slug: "ecommerce" }) as never);
    expect(res.status).toBe(200);
    expect((mundo.atualizado()?.settings as { proposals: { modelos_ocultos: string[] } }).proposals.modelos_ocultos).toEqual([
      "ecommerce",
    ]);
  });

  it("mostrar tira o slug e mantém os outros, auditando proposal_template.shown", async () => {
    const mundo = montarMundo({ settings: { proposals: { enabled: true, modelos_ocultos: ["ecommerce", "automacao"] } } });
    const res = await POST(post({ acao: "mostrar", slug: "ecommerce" }) as never);
    expect(res.status).toBe(200);
    expect((mundo.atualizado()?.settings as { proposals: { modelos_ocultos: string[] } }).proposals.modelos_ocultos).toEqual([
      "automacao",
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal_template.shown" }));
  });
});
