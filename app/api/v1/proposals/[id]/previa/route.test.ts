// app/api/v1/proposals/[id]/previa/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mocks: Record<string, any> = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createAdminClient: vi.fn(),
  renderDocumentoPdf: vi.fn(),
  marcaDaOrganizacaoParaPdf: vi.fn(),
  resolverModelo: vi.fn(),
  audit: vi.fn(),
  traduzir: vi.fn((txt: string) => txt),
}));

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/propostas/documento/pdf-do-documento", () => ({ renderDocumentoPdf: mocks.renderDocumentoPdf }));
vi.mock("@/lib/propostas/marca-da-organizacao-para-pdf", () => ({ marcaDaOrganizacaoParaPdf: mocks.marcaDaOrganizacaoParaPdf }));
vi.mock("@/lib/propostas/modelos/resolver", () => ({ resolverModelo: mocks.resolverModelo }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: mocks.traduzir }));

import { GET } from "./route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG_ID = "33333333-3333-4333-8333-333333333333";
const PROPOSTA_ID = "11111111-1111-4111-8111-111111111111";
const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

interface MundoOpts {
  papel?: keyof typeof ROLE_RANK;
  /** A proposta existe SÓ nesta organização — `null` é a proposta de outra. */
  organizacaoDaLinha?: string;
  templateSlug?: string | null;
  numero?: number | null;
  ano?: number | null;
  /** Briefing que alimenta `{{project.name}}`: `{}` deixa o campo faltando. */
  briefingJson?: unknown;
}

function montarMundo(opts: MundoOpts = {}) {
  const papel = opts.papel ?? "agent";
  const rank = ROLE_RANK[papel] ?? 0;
  mocks.requireRole.mockImplementation(async (minRole: keyof typeof ROLE_RANK) => {
    const minRank = ROLE_RANK[minRole] ?? 0;
    return rank < minRank
      ? { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) }
      : { ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: ORG_ID } };
  });

  const proposta = {
    id: PROPOSTA_ID,
    organization_id: opts.organizacaoDaLinha ?? ORG_ID,
    status: "rascunho",
    template_slug: opts.templateSlug === undefined ? "site_institucional" : opts.templateSlug,
    template_slug_sugerido: null,
    briefing_json: opts.briefingJson ?? { project: { name: "Site da imobiliária" } },
    secoes_editadas: null,
    pricing_status: "manual",
    contact_id: "contato-1",
    titulo: "Site da imobiliária",
    versao: 1,
    prazo_dias_uteis: 30,
    valid_until: "2026-12-31",
    total_cents: 350000,
    moeda: "BRL",
    condicoes: "50% no aceite",
    numero: opts.numero ?? null,
    ano: opts.ano ?? null,
    created_at: "2026-09-26T00:00:00.000Z",
  };

  /** Toda escrita em `crm_proposals` — a prévia NÃO pode nenhuma. */
  const escritasEmPropostas: unknown[] = [];
  const admin = {
    from: vi.fn((tabela: string) => {
      if (tabela === "crm_proposals") {
        return {
          select: () => {
            // Reproduz o WHERE do Postgres: a linha só volta se os DOIS filtros
            // casarem. Proposta de outra organização é `null` — e é por isso que
            // a rota responde 404 sem nunca chegar a vê-la.
            const filtros = new Map<string, unknown>();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cadeia: any = {
              eq(campo: string, valor: unknown) {
                filtros.set(campo, valor);
                return cadeia;
              },
              maybeSingle: async () => {
                const bateOrg = (filtros.get("organization_id") ?? proposta.organization_id) === proposta.organization_id;
                const bateId = (filtros.get("id") ?? proposta.id) === proposta.id;
                return { data: bateOrg && bateId ? proposta : null, error: null };
              },
            };
            return cadeia;
          },
          update: (payload: unknown) => {
            escritasEmPropostas.push(payload);
            return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
          },
          insert: (payload: unknown) => {
            escritasEmPropostas.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (tabela === "crm_proposal_items") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({
                  data: [
                    {
                      id: "item-1",
                      proposal_id: PROPOSTA_ID,
                      product_id: null,
                      descricao: "Site institucional",
                      quantidade: 1,
                      preco_unitario_cents: 350000,
                      desconto_cents: 0,
                      position: 1000,
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (tabela === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { name: "Maria", display_name: "Maria", email: null, phone_number: null }, error: null }),
              }),
            }),
          }),
        };
      }
      if (tabela === "catalog_products") {
        return { select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) };
      }
      throw new Error(`tabela inesperada no mock: ${tabela}`);
    }),
  };
  mocks.createAdminClient.mockReturnValue(admin);

  mocks.resolverModelo.mockImplementation(async (_db: unknown, _org: string, slug: string) => {
    if (!proposta.template_slug) return null;
    return {
      slug,
      version: 1,
      sectionOrder: ["resumo"],
      sections: [{ id: "resumo", title: "Resumo", titleEs: null, body: "Projeto: {{project.name}}", bodyEs: null, required: true, conditional: false }],
      origem: "base",
    };
  });
  mocks.marcaDaOrganizacaoParaPdf.mockResolvedValue({ appName: "Clínica X", accentHex: "#111111", logoUrl: null });
  mocks.renderDocumentoPdf.mockImplementation(async () => Buffer.from("%PDF-1.4 prévia"));

  return {
    escritasEmPropostas,
    async GET() {
      return GET(new Request(`http://localhost/api/v1/proposals/${PROPOSTA_ID}/previa`) as never, {
        params: Promise.resolve({ id: PROPOSTA_ID }),
      });
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.traduzir.mockImplementation((txt: string) => txt);
});

describe("GET /api/v1/proposals/[id]/previa", () => {
  it("200 com o PDF, e NENHUMA escrita em crm_proposals (leitura pura: não aloca número nem muda status)", async () => {
    const mundo = montarMundo();
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe("inline; filename=previa-proposta.pdf");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mundo.escritasEmPropostas).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rascunho: o PDF sai marcado como prévia, sem número nenhum", async () => {
    const mundo = montarMundo();
    await mundo.GET();
    expect(mocks.renderDocumentoPdf).toHaveBeenCalledWith(
      expect.objectContaining({ numero: null, ano: null, previa: true }),
    );
  });

  it("proposta que JÁ tem número: mostra o número, sem o aviso de prévia", async () => {
    const mundo = montarMundo({ numero: 3, ano: 2026 });
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(mocks.renderDocumentoPdf).toHaveBeenCalledWith(
      expect.objectContaining({ numero: 3, ano: 2026 }),
    );
    expect(mocks.renderDocumentoPdf.mock.calls[0][0].previa).toBeUndefined();
  });

  it("sem modelo confirmado: 422 com o mesmo motivo do envio — nunca o PDF legado", async () => {
    const mundo = montarMundo({ templateSlug: null });
    const res = await mundo.GET();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toContain("modelo da proposta");
    expect(mocks.renderDocumentoPdf).not.toHaveBeenCalled();
    expect(mundo.escritasEmPropostas).toEqual([]);
  });

  it("com campo faltando, a prévia abre (200, application/pdf) — com [a definir] no lugar", async () => {
    const mundo = montarMundo({ briefingJson: {} });
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(mundo.escritasEmPropostas).toEqual([]);
    const secoes = mocks.renderDocumentoPdf.mock.calls[0][0].secoes as Array<{ body: string }>;
    expect(secoes[0]?.body).toContain("[a definir]");
  });

  it("proposta de OUTRA organização: 404 — o filtro de org é o que decide, e nada é gerado", async () => {
    const mundo = montarMundo({ organizacaoDaLinha: OUTRA_ORG_ID });
    const res = await mundo.GET();
    expect(res.status).toBe(404);
    expect(mocks.renderDocumentoPdf).not.toHaveBeenCalled();
  });

  it("papel abaixo de agent (viewer): 403, e o PDF não é montado", async () => {
    const mundo = montarMundo({ papel: "viewer" });
    const res = await mundo.GET();
    expect(res.status).toBe(403);
    expect(mocks.renderDocumentoPdf).not.toHaveBeenCalled();
  });
});
