/**
 * O EMBEDDING DE CONVERSAS NÃO GASTA COM ORGANIZAÇÃO PARADA.
 *
 * O cron diário ingere as conversas de toda org com agente ativo; o provedor
 * cobra por token, e quem paga é o dono da instalação. Desde a issue #2015 a
 * org parada sai pelo status EMBUTIDO no select (`organizations:organization_id(status)`),
 * decidido por `ehOperante` — nunca por uma lista de ids negada na URL, que
 * cortaria em `max_rows` sem aviso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  erro: null as { message: string } | null,
  agentes: [] as Array<{
    id: string;
    organization_id: string;
    organizations?: { status?: string | null } | Array<{ status?: string | null }> | null;
  }>,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/rag/ingest/conversations", () => ({ ingestConversationsBatch: mocks.ingest }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => {
        // Cadeia de `eq` (is_active + organizations.status) que resolve na lista do teste.
        const c: Record<string, unknown> = {
          eq: () => c,
          then: (r: (v: unknown) => unknown) =>
            Promise.resolve(mocks.erro ? { data: null, error: mocks.erro } : { data: mocks.agentes, error: null }).then(r),
        };
        return c;
      },
    }),
  }),
}));

import { GET } from "@/app/api/v1/cron/kb-conversations-batch/route";

const pedido = () => new Request("http://localhost/api/v1/cron/kb-conversations-batch") as never;

beforeEach(() => {
  mocks.ingest.mockReset();
  mocks.erro = null;
  mocks.agentes = [
    { id: "agente-parada", organization_id: "org-parada", organizations: { status: "suspended" } },
    { id: "agente-ativa", organization_id: "org-ativa", organizations: { status: "active" } },
  ];
  mocks.ingest.mockResolvedValue({ processed: 1, flaggedReview: 0, skipped: 0 });
});

describe("kb-conversations-batch × organização parada", () => {
  it("não ingere a org parada (status embutido + ehOperante); a operante segue", async () => {
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-ativa" }));
  });

  it("org sem status embutido não é ingerida (falha fechada: sem status = não operante)", async () => {
    mocks.agentes = [{ id: "agente-sem-status", organization_id: "org-x", organizations: null }];
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("erro na leitura dos agentes → 500 e nada é ingerido (falha fechada)", async () => {
    mocks.erro = { message: "connection reset" };
    const res = await GET(pedido());
    expect(res.status).toBe(500);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});