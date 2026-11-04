// app/api/v1/proposals/[id]/documento/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mocks: Record<string, any> = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  createAdminClient: vi.fn(),
  audit: vi.fn(),
  traduzir: vi.fn((txt: string) => txt),
  resolverModelo: vi.fn(),
  resolverAviso: vi.fn(),
}));

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: mocks.traduzir }));
vi.mock("@/lib/propostas/modelos/resolver", () => ({ resolverModelo: mocks.resolverModelo }));
vi.mock("@/lib/propostas/aviso-de-revisao", () => ({ resolverAvisoDeRevisaoSeProntaOuEncerrada: mocks.resolverAviso }));

import { GET, PATCH } from "./route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSTA_ID = "11111111-1111-4111-8111-111111111111";
const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

interface MundoOpts {
  papel?: keyof typeof ROLE_RANK;
  status?: string;
  templateSlug?: string | null;
  sugestao?: string | null;
  secoesEditadas?: Record<string, string> | null;
  briefingJson?: Record<string, unknown> | null;
  contato?: { name: string | null; display_name: string | null } | null;
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

  const propostaRow = {
    id: PROPOSTA_ID,
    organization_id: ORG_ID,
    status: opts.status ?? "rascunho",
    template_slug: opts.templateSlug ?? null,
    template_slug_sugerido: opts.sugestao ?? null,
    briefing_json: opts.briefingJson ?? null,
    secoes_editadas: opts.secoesEditadas ?? null,
    pricing_status: "manual",
    contact_id: "contato-1",
    titulo: "Site catálogo",
    prazo_dias_uteis: 20,
    pagamento: "50_50",
    valid_until: "2026-12-31",
    total_cents: 250000,
    moeda: "BRL",
    created_at: "2026-09-26T00:00:00.000Z",
  };

  let secoesEditadasCapturadas: Record<string, unknown> | undefined;
  let briefingCapturado: Record<string, unknown> | undefined;
  const admin = {
    from: vi.fn((tabela: string) => {
      if (tabela === "crm_proposals") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: propostaRow }),
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            if ("secoes_editadas" in payload) {
              secoesEditadasCapturadas = payload.secoes_editadas as Record<string, unknown>;
            }
            if ("briefing_json" in payload) briefingCapturado = payload.briefing_json as Record<string, unknown>;
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
        };
      }
      if (tabela === "crm_proposal_items") {
        return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [{ preco_unitario_cents: 1000 }] }) }) }) };
      }
      if (tabela === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.contato ?? null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no mock: ${tabela}`);
    }),
  };
  mocks.createAdminClient.mockReturnValue(admin);

  mocks.resolverModelo.mockImplementation(async (_db: unknown, _org: string, slug: string) => {
    if (opts.templateSlug === null || opts.templateSlug === undefined) return null;
    return {
      slug,
      version: 1,
      sectionOrder: ["resumo"],
      sections: [{ id: "resumo", title: "Resumo", titleEs: null, body: "Projeto: {{project.name}}", bodyEs: null, required: true, conditional: false }],
      origem: "base",
    };
  });

  return {
    capturedSecoesEditadas: () => secoesEditadasCapturadas,
    capturedBriefing: () => briefingCapturado,
  };
}

describe("GET /api/v1/proposals/[id]/documento", () => {
  beforeEach(() => vi.clearAllMocks());

  it("proposta sem template_slug devolve secoes vazias, sem lançar (Review Focus)", async () => {
    montarMundo({ templateSlug: null });
    const res = await GET(new Request("http://x") as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.secoes).toEqual([]);
  });

  it("com modelo resolvido, renderiza a seção com o dado do briefing", async () => {
    montarMundo({ templateSlug: "site_institucional", briefingJson: { project: { name: "Site Catálogo" } } });
    const res = await GET(new Request("http://x") as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    const body = await res.json();
    expect(body.data.secoes[0]).toMatchObject({ id: "resumo", body: "Projeto: Site Catálogo" });
  });

  it("seção sobrescrita SOME da lista de pendências (Review Focus)", async () => {
    montarMundo({
      templateSlug: "site_institucional",
      briefingJson: {},
      secoesEditadas: { resumo: "Texto final escrito à mão." },
    });
    const res = await GET(new Request("http://x") as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    const body = await res.json();
    expect(body.data.secoes[0].body).toBe("Texto final escrito à mão.");
    expect(body.data.variaveisFaltando).toEqual([]);
  });

  it("devolve modeloSlugSugerido quando a proposta tem sugestão pendente", async () => {
    montarMundo({ templateSlug: null, sugestao: "ecommerce" });
    const res = await GET(new Request("http://x") as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    const body = await res.json();
    expect(body.data.modeloSlugSugerido).toBe("ecommerce");
  });
});

describe("PATCH /api/v1/proposals/[id]/documento", () => {
  beforeEach(() => vi.clearAllMocks());

  it("manager grava a sobrescrita da seção", async () => {
    const { capturedSecoesEditadas } = montarMundo({ papel: "manager" });
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ secaoId: "resumo", texto: "Novo texto" }) });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    expect(res.status).toBe(200);
    expect(capturedSecoesEditadas()).toMatchObject({ resumo: "Novo texto" });
  });

  it("agent é barrado (403) — só manager+ edita seção (Global Constraint)", async () => {
    montarMundo({ papel: "agent" });
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ secaoId: "resumo", texto: "x" }) });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    expect(res.status).toBe(403);
  });

  it("secaoId vazio é recusado com 422 (Review Focus)", async () => {
    montarMundo({ papel: "manager" });
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ secaoId: "", texto: "x" }) });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    expect(res.status).toBe(422);
  });

  it("texto ausente é recusado com 422", async () => {
    montarMundo({ papel: "manager" });
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ secaoId: "resumo" }) });
    const res = await PATCH(req as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    expect(res.status).toBe(422);
  });
});

describe("PATCH /documento — P1 (spec de 26/09)", () => {
  beforeEach(() => vi.clearAllMocks());

  function patch(body: unknown) {
    return PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }) as never, {
      params: Promise.resolve({ id: PROPOSTA_ID }),
    });
  }

  it("proposta enviada: salvar seção devolve 409 e não grava", async () => {
    const mundo = montarMundo({ status: "enviada", templateSlug: "site_institucional" });
    const res = await patch({ secaoId: "resumo", texto: "x" });
    expect(res.status).toBe(409);
    expect(mundo.capturedSecoesEditadas()).toBeUndefined();
  });

  it("proposta enviada: preencher campo devolve 409 e não grava", async () => {
    const mundo = montarMundo({ status: "enviada", templateSlug: "site_institucional" });
    const res = await patch({ campo: "project.name", valor: "Site" });
    expect(res.status).toBe(409);
    expect(mundo.capturedBriefing()).toBeUndefined();
  });

  it("texto null tira a reescrita (volta ao texto do modelo) e preserva as outras", async () => {
    const mundo = montarMundo({ templateSlug: "site_institucional", secoesEditadas: { resumo: "A", outra: "B" } });
    const res = await patch({ secaoId: "resumo", texto: null });
    expect(res.status).toBe(200);
    expect(mundo.capturedSecoesEditadas()).toEqual({ outra: "B" });
  });

  it("voltar ao modelo na última reescrita grava null, não objeto vazio", async () => {
    const mundo = montarMundo({ templateSlug: "site_institucional", secoesEditadas: { resumo: "A" } });
    await patch({ secaoId: "resumo", texto: null });
    expect(mundo.capturedSecoesEditadas()).toBeNull();
  });

  it("texto só com espaços é recusado (422) — para esvaziar, use voltar ao modelo", async () => {
    montarMundo({ templateSlug: "site_institucional" });
    expect((await patch({ secaoId: "resumo", texto: "   " })).status).toBe(422);
  });

  it("preencher campo grava no briefing, preservando o que já havia", async () => {
    const mundo = montarMundo({ templateSlug: "site_institucional", briefingJson: { client: { company: "X" } } });
    const res = await patch({ campo: "project.name", valor: "  Site da imobiliária  " });
    expect(res.status).toBe(200);
    expect(mundo.capturedBriefing()).toEqual({ client: { company: "X" }, project: { name: "Site da imobiliária" } });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "proposal.documento_campo_preenchido", metadata: { campo: "project.name" } }),
    );
  });

  it("campo que o modelo não usa é recusado (422)", async () => {
    const mundo = montarMundo({ templateSlug: "site_institucional" });
    expect((await patch({ campo: "scope.pages_list", valor: "x" })).status).toBe(422);
    expect(mundo.capturedBriefing()).toBeUndefined();
  });

  it("campo calculado pelo sistema é recusado (422) mesmo que o modelo o use", async () => {
    mocks.resolverModelo.mockImplementationOnce(async () => ({
      slug: "x", version: 1, sectionOrder: ["a"], origem: "base",
      sections: [{ id: "a", title: "A", titleEs: null, body: "{{investment.total_formatted}}", bodyEs: null, required: true, conditional: false }],
    }));
    montarMundo({ templateSlug: "site_institucional" });
    expect((await patch({ campo: "investment.total_formatted", valor: "R$ 1" })).status).toBe(422);
  });

  it("segmento perigoso no caminho é recusado (422)", async () => {
    montarMundo({ templateSlug: "site_institucional" });
    expect((await patch({ campo: "__proto__.x", valor: "y" })).status).toBe(422);
  });

  it("sem modelo confirmado, preencher campo é recusado (422)", async () => {
    montarMundo({ templateSlug: null });
    expect((await patch({ campo: "project.name", valor: "Site" })).status).toBe(422);
  });

  it("depois de gravar, tenta fechar o aviso de revisão", async () => {
    montarMundo({ templateSlug: "site_institucional" });
    await patch({ campo: "project.name", valor: "Site" });
    expect(mocks.resolverAviso).toHaveBeenCalledWith(expect.anything(), ORG_ID, PROPOSTA_ID);
  });
});

describe("GET /documento — P1", () => {
  beforeEach(() => vi.clearAllMocks());

  it("devolve status, camposFaltando com nome legível e temSecaoEditada", async () => {
    montarMundo({ templateSlug: "site_institucional", briefingJson: {}, secoesEditadas: { outra: "x" } });
    const res = await GET(new Request("http://x") as never, { params: Promise.resolve({ id: PROPOSTA_ID }) });
    const body = await res.json();
    expect(body.data.status).toBe("rascunho");
    expect(body.data.temSecaoEditada).toBe(true);
    expect(body.data.camposFaltando).toEqual([
      { caminho: "project.name", rotulo: "Nome do projeto", onde: "briefing", secoes: ["resumo"] },
    ]);
  });
});
