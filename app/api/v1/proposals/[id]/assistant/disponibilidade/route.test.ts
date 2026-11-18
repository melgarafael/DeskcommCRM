// app/api/v1/proposals/[id]/assistant/disponibilidade/route.test.ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  createAdminClient: vi.fn(),
  audit: vi.fn(),
  orcamentoDeIaDisponivel: vi.fn(),
}));

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/propostas/orcamento-de-ia-disponivel", () => ({
  orcamentoDeIaDisponivel: mocks.orcamentoDeIaDisponivel,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";

const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };

function montarMundo(opts: { papel?: keyof typeof ROLE_RANK; propostaExiste?: boolean; disponibilidade?: { disponivel: boolean; motivo: string | null } } = {}) {
  const papel = opts.papel ?? "agent";
  const rank = ROLE_RANK[papel] ?? 0;
  mocks.requireRole.mockImplementation(async (min: string) => {
    const minRank = ROLE_RANK[min] ?? 0;
    return rank < minRank
      ? { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) }
      : { ok: true, user: { id: USER_ID, idioma: "pt-BR" }, org: { orgId: ORG_ID } };
  });
  mocks.requireSupportWrite.mockResolvedValue(null);
  mocks.createAdminClient.mockReturnValue({
    from: (tabela: string) => {
      if (tabela !== "crm_proposals") throw new Error(`tabela não mockada: ${tabela}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.propostaExiste === false ? { data: null, error: null } : { data: { id: PROPOSAL_ID }, error: null },
            }),
          }),
        }),
      };
    },
  });
  mocks.orcamentoDeIaDisponivel.mockResolvedValue(opts.disponibilidade ?? { disponivel: true, motivo: null });

  return {
    async GET() {
      const { GET } = await import("./route");
      const res = await GET(new NextRequest(`http://localhost/api/v1/proposals/${PROPOSAL_ID}/assistant/disponibilidade`), {
        params: Promise.resolve({ id: PROPOSAL_ID }),
      });
      return { status: res.status, body: await res.clone().json() };
    },
  };
}

describe("GET /api/v1/proposals/[id]/assistant/disponibilidade", () => {
  beforeEach(() => vi.resetAllMocks());

  it("orçamento disponível: { disponivel: true, motivo: null }", async () => {
    const mundo = montarMundo();
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ disponivel: true, motivo: null });
  });

  it("orçamento estourado: { disponivel: false } com motivo legível", async () => {
    const mundo = montarMundo({ disponibilidade: { disponivel: false, motivo: "O orçamento mensal de IA desta organização foi atingido." } });
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(res.body.data.disponivel).toBe(false);
    expect(res.body.data.motivo).toContain("orçamento mensal de IA");
  });

  it("proposta de outra organização (ou inexistente): 404", async () => {
    const mundo = montarMundo({ propostaExiste: false });
    const res = await mundo.GET();
    expect(res.status).toBe(404);
  });

  it("papel viewer (abaixo de agent): 403", async () => {
    const mundo = montarMundo({ papel: "viewer" });
    const res = await mundo.GET();
    expect(res.status).toBe(403);
  });
});
