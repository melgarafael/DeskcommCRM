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
  inFilters: [string, unknown[]][] = [];
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
  in(key: string, values: unknown[]) {
    this.inFilters.push([key, values]);
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
      .filter((row) => this.inFilters.every(([key, values]) => values.includes(row[key])))
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

  it("pagina as propostas de campo do titular, sem teto", async () => {
    // A fila de propostas é alimentada pela IA enquanto a conversa dura: um `limit`
    // aqui entregaria um relatório de acesso incompleto — e em silêncio.
    rows.contact_field_proposals = Array.from({ length: 501 }, (_, index) => ({
      id: `proposta-${index}`,
      organization_id: ORG,
      contact_id: CONTACT,
      campo: "phone_number",
      valor_proposto: "+5511988887777",
      valor_anterior: null,
      conversation_id: "conversation-a",
      trecho: "meu celular e esse",
      status: "pending",
      proposed_at: "2026-09-16T00:00:00Z",
      decided_at: null,
      motivo_recusa: null,
    }));
    const payload = await collectExportData(request);
    expect(payload.contact_field_proposals).toHaveLength(501);
    expect(payload.contact_field_proposals?.at(-1)?.id).toBe("proposta-500");
    expect(
      reads.filter((read) => read.table === "contact_field_proposals").map((read) => read.range),
    ).toEqual([
      [0, 499],
      [500, 999],
    ]);
  });

  it("entrega o rascunho e as propostas DO titular, nunca de outro contato ou de outro tenant", async () => {
    // O gate de paridade só vê que a tabela é visitada; perder o filtro de contato
    // entregaria ao titular o texto escrito para OUTRA pessoa — e nada reprovaria.
    rows.conversations = [
      { id: "conv-a", organization_id: ORG, contact_id: CONTACT },
      { id: "conv-b", organization_id: ORG, contact_id: OTHER_CONTACT },
    ];
    const rascunho = (id: string, organization_id: string, conversation_id: string): Row => ({
      id,
      organization_id,
      conversation_id,
      body: `texto ${id}`,
      source: "integracao",
      consumed_at: null,
      created_at: "2026-09-16T00:00:00Z",
      created_by_api_token_id: "PRIVATE-TOKEN",
      consumed_by_user_id: "PRIVATE-USER",
    });
    rows.conversation_drafts = [
      rascunho("d-mine", ORG, "conv-a"),
      rascunho("d-other-contact", ORG, "conv-b"),
      rascunho("d-other-tenant", OTHER_ORG, "conv-a"),
    ];
    const proposta = (id: string, organization_id: string, contact_id: string): Row => ({
      id,
      organization_id,
      contact_id,
      campo: "email",
      valor_proposto: "x@example.test",
      valor_anterior: null,
      conversation_id: "conv-a",
      trecho: "meu email",
      status: "pending",
      proposed_at: "2026-09-16T00:00:00Z",
      decided_at: null,
      motivo_recusa: null,
      proposed_by_agent_id: "PRIVATE-AGENT",
      decided_by_user_id: "PRIVATE-USER",
    });
    rows.contact_field_proposals = [
      proposta("p-mine", ORG, CONTACT),
      proposta("p-other-contact", ORG, OTHER_CONTACT),
      proposta("p-other-tenant", OTHER_ORG, CONTACT),
    ];
    const payload = await collectExportData(request);
    expect(payload.conversation_drafts?.map((draft) => draft.id)).toEqual(["d-mine"]);
    expect(payload.contact_field_proposals?.map((proposal) => proposal.id)).toEqual(["p-mine"]);
    expect(
      JSON.stringify([payload.conversation_drafts, payload.contact_field_proposals]),
    ).not.toMatch(/PRIVATE|other-contact|other-tenant/);
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
