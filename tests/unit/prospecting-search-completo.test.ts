import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { synchronizeSearch } from "@/lib/prospecting/store";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/prospecting/provedor", () => ({
  provedorDaOrganizacao: vi.fn(),
  validarCredencialDaOrganizacao: vi.fn(),
}));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "CHAVE"),
  encryptWebhookSecret: vi.fn(async () => "CHAVE"),
}));

import { provedorDaOrganizacao } from "@/lib/prospecting/provedor";

const ORG = "00000000-0000-4000-8000-000000000001";
const CAMP = "00000000-0000-4000-8000-000000000002";

function item(placeId: string, extra: Record<string, unknown> = {}) {
  return {
    placeId,
    title: `Empresa ${placeId}`,
    phoneUnformatted: "+5511999990000",
    website: "https://empresa.test",
    categoryName: "Clínica",
    address: "Rua X",
    url: "https://maps.test/x",
    totalScore: 4.9,
    reviewsCount: 30,
    emails: [],
    ...extra,
  };
}

/** Banco falso: dedup por place_id como o `on conflict do nothing`. */
function bancoFake(vistos: Set<string>) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  return {
    updates,
    db: {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("from prospecting_settings")) {
          return { rows: [{ credential_encrypted: "cifrada" }] };
        }
        if (sql.includes("insert into prospecting_candidates")) {
          const place = params[2] as string;
          if (vistos.has(place)) return { rowCount: 0 };
          vistos.add(place);
          updates.push({ sql, params });
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
    } as never,
  };
}

describe("synchronizeSearch com enriquecimento puro", () => {
  beforeEach(() => {
    vi.mocked(audit).mockReset();
  });

  it("resolve agregador no insert e audita o funil uma vez", async () => {
    vi.mocked(provedorDaOrganizacao).mockResolvedValue({
      readSearch: async () => ({ status: "SUCCEEDED", defaultDatasetId: "data-1" }),
      readResults: async () => [
        item("p1", { website: "https://instagram.com/x" }),
        item("p2"),
        { title: "", placeId: "" },
      ],
    } as never);
    const { db } = bancoFake(new Set());
    await synchronizeSearch(
      db,
      {} as never,
      {
        id: CAMP,
        organization_id: ORG,
        search: { limit: 20 },
        run_id: "run-1",
        dataset_id: null,
      } as never,
    );
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    const chamada = vi.mocked(audit).mock.calls[0]![0] as { action: string; metadata: Record<string, unknown> };
    expect(chamada.action).toBe("prospecting.search_completed");
    expect(chamada.metadata).toMatchObject({ total: 3, inseridos: 2, invalidos: 1, duplicados: 0 });
    expect(chamada.metadata["classes_puras"]).toMatchObject({ agregador: 1 });
  });

  it("duplicado conta como já-na-base e não reinsere", async () => {
    vi.mocked(provedorDaOrganizacao).mockResolvedValue({
      readSearch: async () => ({ status: "SUCCEEDED", defaultDatasetId: "data-1" }),
      readResults: async () => [item("p1")],
    } as never);
    const { db, updates } = bancoFake(new Set(["p1"]));
    await synchronizeSearch(
      db,
      {} as never,
      {
        id: CAMP,
        organization_id: ORG,
        search: { limit: 20 },
        run_id: "run-1",
        dataset_id: null,
      } as never,
    );
    expect(updates).toHaveLength(0);
    const chamada = vi.mocked(audit).mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(chamada.metadata).toMatchObject({ total: 1, inseridos: 0, duplicados: 1, invalidos: 0 });
  });
});
