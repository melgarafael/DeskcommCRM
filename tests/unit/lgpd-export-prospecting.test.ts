import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";

type Row = Record<string, unknown>;
const ORG = "tenant-a",
  OTHER_ORG = "tenant-b",
  CONTACT = "contact-a",
  OTHER_CONTACT = "contact-b";
const request = {
  organizationId: ORG,
  requestId: "export-1",
  contactId: CONTACT,
  externalCustomerId: null,
};
let rows: Record<string, Row[]>;
let failure: { message: string } | null;
const reads: { table: string; columns: string; range: [number, number] }[] = [];

/** Execute the collector's filters and projection against mixed-owner fixtures. */
class ReadQuery {
  columns = "";
  filters: [string, unknown][] = [];
  page: [number, number] = [0, 1000];
  constructor(readonly table: string) {}
  select(columns: string) {
    this.columns = columns;
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push([key, value]);
    return this;
  }
  order() {
    return this;
  }
  limit(limit: number) {
    this.page = [0, limit - 1];
    return this;
  }
  range(from: number, to: number) {
    this.page = [from, to];
    return this;
  }
  or() {
    return this;
  }
  async maybeSingle() {
    const result = await this.execute();
    return { ...result, data: result.data?.[0] ?? null };
  }
  then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }
  async execute() {
    reads.push({ table: this.table, columns: this.columns, range: this.page });
    if (this.table === "prospecting_candidates" && failure) return { data: null, error: failure };
    const data = (rows[this.table] ?? [])
      .filter((row) => this.filters.every(([key, value]) => row[key] === value))
      .slice(this.page[0], this.page[1] + 1)
      .map((row) =>
        Object.fromEntries(
          this.columns
            .split(",")
            .map((column) => column.trim())
            .map((column) => [column, row[column]]),
        ),
      );
    return { data, error: null };
  }
}

function candidate(id: string, organization_id = ORG, contact_id: string | null = CONTACT): Row {
  return {
    id,
    organization_id,
    contact_id,
    campaign_id: "campaign-a",
    lead_id: "lead-a",
    conversation_id: "conversation-a",
    place_id: `maps-${id}`,
    phone: "+5511988880000",
    data: {
      name: "Contato de teste",
      address: "Rua Teste",
      emails: ["comercial@example.test"],
      socials: ["https://example.test/perfil"],
    },
    status: "sent",
    attempted_at: "2026-09-16T00:00:00Z",
    error: null,
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    service_boundary: { authorization: "PRIVATE-AUTHORIZATION" },
    suppression_salt: "PRIVATE-SALT",
    suppression_place: "PRIVATE-PLACE-TOKEN",
    suppression_phone: "PRIVATE-PHONE-TOKEN",
  };
}

beforeEach(() => {
  reads.length = 0;
  failure = null;
  rows = {
    organizations: [
      { id: ORG, legal_name: "Empresa Teste", display_name: "Teste", dpo_email: null },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        name: "Contato de teste",
        phone_number: "+5511988880000",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    prospecting_candidates: [
      candidate("mine"),
      candidate("other-contact", ORG, OTHER_CONTACT),
      candidate("other-tenant", OTHER_ORG),
      candidate("unlinked", ORG, null),
    ],
  };
  mock.admin.mockReturnValue({ from: (table: string) => new ReadQuery(table) });
});

describe("LGPD: dados da prospecção no pedido de acesso", () => {
  it("entrega a pesquisa do titular sem dados de outros contatos/tenants nem material interno", async () => {
    const payload = await collectExportData(request);
    expect(payload.prospecting_candidates).toEqual([
      expect.objectContaining({
        id: "mine",
        campaign_id: "campaign-a",
        phone: "+5511988880000",
        place_id: "maps-mine",
        status: "sent",
        data: {
          name: "Contato de teste",
          address: "Rua Teste",
          emails: ["comercial@example.test"],
          socials: ["https://example.test/perfil"],
        },
      }),
    ]);
    expect(JSON.stringify(payload.prospecting_candidates)).not.toMatch(
      /PRIVATE|suppression_|service_boundary|other-contact|other-tenant|unlinked/,
    );
    expect(reads.filter((read) => read.table === "prospecting_candidates")).toHaveLength(1);
  });

  it("pagina para entregar registros além dos primeiros 500", async () => {
    rows.prospecting_candidates = Array.from({ length: 501 }, (_, index) =>
      candidate(`mine-${index}`),
    );
    const payload = await collectExportData(request);
    expect(payload.prospecting_candidates).toHaveLength(501);
    expect(payload.prospecting_candidates.at(-1)?.id).toBe("mine-500");
    expect(
      reads.filter((read) => read.table === "prospecting_candidates").map((read) => read.range),
    ).toEqual([
      [0, 499],
      [500, 999],
    ]);
  });

  it("sem titular mantém a seção vazia e não consulta registros pessoais", async () => {
    const payload = await collectExportData({ ...request, contactId: null });
    expect(payload.prospecting_candidates).toEqual([]);
    expect(reads.map((read) => read.table)).toEqual(["organizations"]);
  });

  it("não entrega export aparentemente completo quando a coleta de prospecção falha", async () => {
    failure = { message: "database unavailable" };
    await expect(collectExportData(request)).rejects.toEqual(failure);
  });
});
