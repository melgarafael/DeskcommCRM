/**
 * O EMBEDDING DE CONVERSAS NÃO GASTA COM ORGANIZAÇÃO PARADA.
 *
 * O cron diário ingere as conversas de toda org com agente ativo; o provedor
 * cobra por token, e quem paga é o dono da instalação.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  paradas: vi.fn(),
  agentes: [] as Array<{ id: string; organization_id: string }>,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/rag/ingest/conversations", () => ({ ingestConversationsBatch: mocks.ingest }));
vi.mock("@/lib/organizacao/operante", () => ({ idsDeOrgsParadas: mocks.paradas }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: mocks.agentes, error: null }) }) }),
  }),
}));

import { GET } from "@/app/api/v1/cron/kb-conversations-batch/route";

const pedido = () => new Request("http://localhost/api/v1/cron/kb-conversations-batch") as never;

beforeEach(() => {
  mocks.ingest.mockReset();
  mocks.paradas.mockReset();
  mocks.agentes = [
    { id: "agente-parada", organization_id: "org-parada" },
    { id: "agente-ativa", organization_id: "org-ativa" },
  ];
  mocks.ingest.mockResolvedValue({ processed: 1, flaggedReview: 0, skipped: 0 });
});

describe("kb-conversations-batch × organização parada", () => {
  it("não ingere a org parada; a operante segue", async () => {
    mocks.paradas.mockResolvedValue(["org-parada"]);
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-ativa" }));
  });

  it("leitura das paradas falha → 500 e nada é ingerido (falha fechada)", async () => {
    mocks.paradas.mockRejectedValue(new Error("connection reset"));
    const res = await GET(pedido());
    expect(res.status).toBe(500);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
