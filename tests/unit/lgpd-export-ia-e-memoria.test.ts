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
  requestId: "export-ai-memoria",
  contactId: CONTACT,
  externalCustomerId: null,
};
let rows: Record<string, Row[]>;
const reads: { table: string; columns: string; range: [number, number] }[] = [];

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

function nota(
  id: string,
  organization_id: string,
  contact_id: string,
  headline: string,
  body: string,
): Row {
  return {
    id,
    organization_id,
    contact_id,
    headline,
    body,
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
  };
}

function run(
  id: string,
  organization_id: string,
  contact_id: string,
  toolCalls: unknown,
): Row {
  return {
    id,
    organization_id,
    contact_id,
    tool_calls: toolCalls,
    created_at: "2026-09-15T00:00:00Z",
  };
}

function estado(
  id: string,
  organization_id: string,
  contact_id: string,
  nextAction: string | null,
  qualification: unknown,
): Row {
  return {
    id,
    organization_id,
    contact_id,
    next_action: nextAction,
    qualification,
    updated_at: "2026-09-16T00:00:00Z",
  };
}

const TEXTOS_DO_TITULAR = [
  "Joana Teste quer trocar para o plano premium",
  "lembre de ligar segunda as 10h",
];
const TEXTO_ALHEIO = "conteudo de outro contato";
// O `result` de `crm_search_contacts` traz OUTROS contatos (lib/mcp/tools/contacts.ts).
const TELEFONE_DE_TERCEIRO = "+5511988887777";
const EMAIL_DE_TERCEIRO = "outra@exemplo.com";
const TEXTO_DO_MODELO = "achei a Maria Terceira no cadastro";
const TEXTO_OUTRO_TENANT = "conteudo de outro tenant";

beforeEach(() => {
  reads.length = 0;
  rows = {
    organizations: [
      { id: ORG, legal_name: "Empresa Teste", display_name: "Teste", dpo_email: null },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        name: "Joana Teste",
        phone_number: "+551****0000",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    lead_notes: [
      nota("nota-mine", ORG, CONTACT, TEXTOS_DO_TITULAR[0]!, TEXTOS_DO_TITULAR[1]!),
      nota("nota-other-contact", ORG, OTHER_CONTACT, TEXTO_ALHEIO, TEXTO_ALHEIO),
      nota("nota-other-tenant", OTHER_ORG, CONTACT, TEXTO_OUTRO_TENANT, TEXTO_OUTRO_TENANT),
    ],
    ai_agent_runs: [
      // Forma real do serializer (lib/ai/runtime/serialize.ts): por passo
      // `{ step, text, finish_reason, tool_calls: [{ tool_name, args, result }] }`.
      run("run-mine", ORG, CONTACT, [
        {
          step: 0,
          text: TEXTO_DO_MODELO,
          finish_reason: "tool-calls",
          tokens_in: 900,
          tokens_out: 40,
          tool_calls: [
            {
              tool_name: "add_note",
              args: { text: TEXTOS_DO_TITULAR[0], nome: "Joana Teste" },
              result: { ok: true },
            },
            {
              tool_name: "crm_search_contacts",
              args: { query: "Joana Teste" },
              result: {
                contacts: [
                  { id: OTHER_CONTACT, name: "Maria Terceira", phone: TELEFONE_DE_TERCEIRO, email: EMAIL_DE_TERCEIRO },
                ],
              },
            },
          ],
        },
      ]),
      run("run-other-contact", ORG, OTHER_CONTACT, [
        { step: 0, tool_calls: [{ tool_name: "internal", args: { text: TEXTO_ALHEIO } }] },
      ]),
      run("run-other-tenant", OTHER_ORG, CONTACT, [
        { step: 0, tool_calls: [{ tool_name: "internal", args: { text: TEXTO_OUTRO_TENANT } }] },
      ]),
    ],
    lead_state: [
      estado("estado-mine", ORG, CONTACT, "ligar segunda", { nivel: "quente", interesse: "premium" }),
      estado("estado-other-contact", ORG, OTHER_CONTACT, TEXTO_ALHEIO, { nivel: "frio" }),
      estado("estado-other-tenant", OTHER_ORG, CONTACT, TEXTO_OUTRO_TENANT, { nivel: "medio" }),
    ],
  };
  mock.admin.mockReturnValue({ from: (table: string) => new ReadQuery(table) });
});

describe("LGPD: export do titular traz a memória da IA e o estado da lead", () => {
  it("lead_notes entrega headline+body do titular, sem outro contato nem outro tenant", async () => {
    const payload = await collectExportData(request);
    expect(payload.lead_notes?.map((n) => n.id)).toEqual(["nota-mine"]);
    expect(payload.lead_notes![0]).toEqual(
      expect.objectContaining({
        headline: TEXTOS_DO_TITULAR[0],
        body: TEXTOS_DO_TITULAR[1],
      }),
    );
    expect(JSON.stringify(payload.lead_notes)).toContain(TEXTOS_DO_TITULAR[0]!);
    expect(JSON.stringify(payload.lead_notes)).not.toMatch(
      new RegExp(`${TEXTO_ALHEIO}|${TEXTO_OUTRO_TENANT}`),
    );
    expect(reads.filter((read) => read.table === "lead_notes")).toHaveLength(1);
  });

  it("ai_agent_runs entrega os argumentos de tool_calls do titular, filtrado por org e contato", async () => {
    const payload = await collectExportData(request);
    expect(payload.ai_agent_runs?.map((r) => r.id)).toEqual(["run-mine"]);
    expect(JSON.stringify(payload.ai_agent_runs)).toContain(TEXTOS_DO_TITULAR[0]!);
    expect(JSON.stringify(payload.ai_agent_runs)).not.toMatch(
      new RegExp(`${TEXTO_ALHEIO}|${TEXTO_OUTRO_TENANT}|internal`),
    );
    expect(reads.filter((read) => read.table === "ai_agent_runs")).toHaveLength(1);
  });

  it("ai_agent_runs NÃO entrega o resultado das ferramentas nem o texto do modelo (dado de terceiros)", async () => {
    const payload = await collectExportData(request);
    expect(payload.ai_agent_runs![0]!.tool_calls).toEqual([
      {
        step: 0,
        tool_calls: [
          { tool_name: "add_note", args: { text: TEXTOS_DO_TITULAR[0], nome: "Joana Teste" } },
          { tool_name: "crm_search_contacts", args: { query: "Joana Teste" } },
        ],
      },
    ]);
    const json = JSON.stringify(payload);
    expect(json).not.toContain(TELEFONE_DE_TERCEIRO);
    expect(json).not.toContain(EMAIL_DE_TERCEIRO);
    expect(json).not.toContain(TEXTO_DO_MODELO);
  });

  it("run já redigida pela cascata sai como está: só o nome das ferramentas", async () => {
    const redigido = [{ step: 0, redacted: true, tool_calls: [{ tool_name: "crm_search_contacts" }] }];
    rows.ai_agent_runs = [run("run-redigida", ORG, CONTACT, redigido)];
    const payload = await collectExportData(request);
    expect(payload.ai_agent_runs).toEqual([
      expect.objectContaining({ id: "run-redigida", tool_calls: redigido }),
    ]);
  });

  it("lead_state entrega next_action e qualification do titular, filtrado por org e contato", async () => {
    const payload = await collectExportData(request);
    expect(payload.lead_state?.map((s) => s.id)).toEqual(["estado-mine"]);
    expect(payload.lead_state![0]).toEqual(
      expect.objectContaining({
        next_action: "ligar segunda",
        qualification: { nivel: "quente", interesse: "premium" },
      }),
    );
    expect(JSON.stringify(payload.lead_state)).not.toMatch(
      new RegExp(`${TEXTO_ALHEIO}|${TEXTO_OUTRO_TENANT}`),
    );
    expect(reads.filter((read) => read.table === "lead_state")).toHaveLength(1);
  });

  it("os textos plantados aparecem no arquivo gerado (JSON que o worker sobe)", async () => {
    const payload = await collectExportData(request);
    const json = JSON.stringify(payload);
    // data.json é `JSON.stringify(data)`: se o texto não aparece no payload,
    // não aparece no arquivo que o titular recebe.
    expect(json).toContain(TEXTOS_DO_TITULAR[0]!);
    expect(json).toContain(TEXTOS_DO_TITULAR[1]!);
    expect(json).toContain('"next_action":"ligar segunda"');
    expect(json).toContain("premium");
    expect(json).not.toMatch(new RegExp(`${TEXTO_ALHEIO}|${TEXTO_OUTRO_TENANT}`));
  });

  it("sem titular mantém as três seções vazias e não consulta registros pessoais", async () => {
    const payload = await collectExportData({ ...request, contactId: null });
    expect(payload.lead_notes).toEqual([]);
    expect(payload.ai_agent_runs).toEqual([]);
    expect(payload.lead_state).toEqual([]);
    expect(reads.map((read) => read.table)).toEqual(["organizations"]);
  });
});