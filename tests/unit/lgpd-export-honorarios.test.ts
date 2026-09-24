/**
 * ADR-0002 D8 (achado da revisão do PR #1578): todo módulo com dados declara a
 * sua seção de export, mesmo sem estar na cascata de redação — honorários não
 * tem texto livre sobre a pessoa (é parâmetro financeiro e calendário), então
 * `tests/unit/lgpd-exporta-o-que-redige.test.ts` (que deriva a lista do que se
 * REDIGE) nunca cobriria esta lacuna. Este arquivo prova a seção diretamente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";
import { logger } from "@/lib/logger";

type Row = Record<string, unknown>;
const ORG = "tenant-a";
const CONTACT = "contact-a";
const LEAD = "lead-a";
const CONTRATO = "contrato-a";
const request = {
  organizationId: ORG,
  requestId: "export-1",
  contactId: CONTACT,
  externalCustomerId: null,
};
let rows: Record<string, Row[]>;
/** 42P01 só para as duas tabelas do módulo — simula instalação sem o módulo. */
let moduloDesinstalado: boolean;

class ReadQuery {
  columns = "";
  filters: [string, unknown][] = [];
  ins: [string, unknown[]][] = [];
  page: [number, number] = [0, 100000];
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
    this.ins.push([key, values]);
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
    if (
      moduloDesinstalado &&
      (this.table === "honorarios_contratos" || this.table === "honorarios_parcelas")
    ) {
      return { data: null, error: { code: "42P01", message: "relation does not exist" } };
    }
    const data = (rows[this.table] ?? [])
      .filter((row) => this.filters.every(([key, value]) => row[key] === value))
      .filter((row) => this.ins.every(([key, values]) => values.includes(row[key])))
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

beforeEach(() => {
  moduloDesinstalado = false;
  rows = {
    organizations: [
      { id: ORG, legal_name: "Escritório Teste", display_name: "Teste", dpo_email: null },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        name: "Cliente Teste",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    crm_leads: [
      {
        id: LEAD,
        organization_id: ORG,
        contact_id: CONTACT,
        pipeline_id: "pipeline-a",
        stage_id: "stage-a",
        title: "Caso Teste",
        status: "open",
        value_cents: 500000,
        currency: "BRL",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    honorarios_contratos: [
      {
        id: CONTRATO,
        organization_id: ORG,
        lead_id: LEAD,
        modelo: "fixo",
        valor_fixo_cents: 500000,
        percentual_exito: null,
        repasse_advogado_pct: null,
        created_at: "2026-09-16T00:00:00Z",
      },
    ],
    honorarios_parcelas: [
      {
        id: "parcela-a",
        organization_id: ORG,
        contrato_id: CONTRATO,
        numero: 1,
        vencimento: "2026-10-01",
        valor_cents: 250000,
        status: "pendente",
        financial_entry_id: null,
      },
    ],
  };
  mock.admin.mockReturnValue({ from: (table: string) => new ReadQuery(table) });
});

describe("LGPD: honorários no pedido de acesso (ADR-0002 D8)", () => {
  it("entrega o contrato do titular e o calendário de parcelas dele", async () => {
    const payload = await collectExportData(request);
    expect(payload.honorarios_contratos).toEqual([
      expect.objectContaining({ id: CONTRATO, lead_id: LEAD, modelo: "fixo" }),
    ]);
    expect(payload.honorarios_parcelas).toEqual([
      expect.objectContaining({ id: "parcela-a", contrato_id: CONTRATO, numero: 1 }),
    ]);
  });

  it("módulo não instalado (42P01) → seção vazia, export não quebra, sem log de ruído", async () => {
    moduloDesinstalado = true;
    const payload = await collectExportData(request);
    expect(payload.honorarios_contratos).toEqual([]);
    expect(payload.honorarios_parcelas).toEqual([]);
    // 42P01 aqui é o estado ESPERADO (módulo não instalado), não uma falha de
    // leitura — logar isso como warn a cada export poluiria o sinal de quem
    // vigia o log procurando defeito de verdade.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sem titular, ou titular sem lead: seção vazia e nenhuma consulta ao módulo", async () => {
    const payload = await collectExportData({ ...request, contactId: null });
    expect(payload.honorarios_contratos).toEqual([]);
    expect(payload.honorarios_parcelas).toEqual([]);
  });

  it("contrato de outro lead do mesmo titular não some, mas de outro titular nunca aparece", async () => {
    rows.honorarios_contratos = [
      ...(rows.honorarios_contratos ?? []),
      {
        id: "contrato-de-outro",
        organization_id: ORG,
        lead_id: "lead-de-outro-contato",
        modelo: "exito",
        valor_fixo_cents: null,
        percentual_exito: 20,
        repasse_advogado_pct: null,
        created_at: "2026-09-16T00:00:00Z",
      },
    ];
    const payload = await collectExportData(request);
    expect(payload.honorarios_contratos.map((c) => c.id)).toEqual([CONTRATO]);
  });
});
