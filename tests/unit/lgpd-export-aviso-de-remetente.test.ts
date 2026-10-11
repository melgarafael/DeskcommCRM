/**
 * LGPD — o aviso "Lembrete aguardando definição do canal" (#2669) no export.
 *
 * O aviso nasce em `lib/agenda/aviso-de-remetente.ts` com
 * `ref_kind = REF_REMETENTE_LEMBRETE`, preso a um compromisso. O coletor o lê
 * junto dos outros avisos de compromisso (`lib/lgpd/export-collector.ts`, o
 * `.in("ref_kind", ...)` de `agent_inbox_items`), e o que vale fixar:
 *   - o do compromisso do titular vai para `appointment_notices` (o PDF lista);
 *   - o do compromisso de outro contato não vai;
 *   - `appointment_notices` é seção da equipe e não sai no `data.json`
 *     (`SECOES_DA_EQUIPE`, `lib/lgpd/copia-do-titular.ts`).
 *
 * O dublê aplica `.eq`/`.in` de verdade: voltar o filtro para
 * `.eq("ref_kind", "appointment")` derruba o primeiro caso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";
import { partesDoArquivoDoTitular } from "@/lib/lgpd/copia-do-titular";
import { REF_REMETENTE_LEMBRETE } from "@/lib/agenda/aviso-de-remetente";

type Tabelas = Database["public"]["Tables"];
type Linhas = { [T in keyof Tabelas]?: Partial<Tabelas[T]["Row"]>[] };

const ORG = "org-a";
const TITULAR = "contato-titular";
const VIZINHO = "contato-vizinho";
const request = { organizationId: ORG, requestId: "export-1", contactId: TITULAR, externalCustomerId: null };
let tabelas: Map<string, Record<string, unknown>[]>;

function semear(linhas: Linhas) {
  tabelas = new Map(Object.entries(linhas));
}

class ReadQuery {
  columns = "";
  eqs: [string, unknown][] = [];
  ins: [string, unknown[]][] = [];
  page: [number, number] = [0, 100000];
  constructor(readonly table: string) {}
  select(columns: string) {
    this.columns = columns;
    return this;
  }
  eq(key: string, value: unknown) {
    this.eqs.push([key, value]);
    return this;
  }
  in(key: string, values: unknown[]) {
    this.ins.push([key, values]);
    return this;
  }
  order() {
    return this;
  }
  or() {
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
  async maybeSingle() {
    const result = await this.execute();
    return { ...result, data: result.data[0] ?? null };
  }
  then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }
  async execute() {
    const data = (tabelas.get(this.table) ?? [])
      .filter((row) => this.eqs.every(([key, value]) => row[key] === value))
      .filter((row) => this.ins.every(([key, values]) => values.includes(row[key])))
      .slice(this.page[0], this.page[1] + 1)
      .map((row) =>
        Object.fromEntries(
          this.columns.split(",").map((c) => c.trim()).map((c) => [c, row[c]]),
        ),
      );
    return { data, error: null };
  }
}

function aviso(id: string, compromisso: string, body: string) {
  return {
    id,
    organization_id: ORG,
    kind: "other",
    ref_kind: REF_REMETENTE_LEMBRETE,
    ref_id: compromisso,
    title: "Lembrete aguardando definição do canal",
    body,
    status: "open",
    created_at: "2026-10-09T10:00:00Z",
    resolved_at: null,
  };
}

beforeEach(() => {
  semear({
    organizations: [{ id: ORG, legal_name: "Clínica Teste", display_name: "Teste", dpo_email: null }],
    contacts: [
      { id: TITULAR, organization_id: ORG, name: "Titular", created_at: "2026-09-15T00:00:00Z" },
      { id: VIZINHO, organization_id: ORG, name: "Vizinho", created_at: "2026-09-15T00:00:00Z" },
    ],
    calendar_appointments: [
      { id: "compromisso-titular", organization_id: ORG, contact_id: TITULAR },
      { id: "compromisso-vizinho", organization_id: ORG, contact_id: VIZINHO },
    ],
    agent_inbox_items: [
      aviso("aviso-titular", "compromisso-titular", "REMETENTE-DO-TITULAR"),
      aviso("aviso-vizinho", "compromisso-vizinho", "REMETENTE-DO-VIZINHO"),
    ],
  });
  mock.admin.mockReturnValue({ from: (table: string) => new ReadQuery(table) });
});

describe("LGPD: aviso de remetente do lembrete no export (#2669)", () => {
  it("o aviso do compromisso do titular entra em appointment_notices", async () => {
    const data = await collectExportData(request);
    expect(data.appointment_notices).toEqual([
      expect.objectContaining({ id: "aviso-titular", ref_id: "compromisso-titular", body: "REMETENTE-DO-TITULAR" }),
    ]);
  });

  it("o aviso do compromisso de outro contato não entra", async () => {
    const data = await collectExportData(request);
    expect(JSON.stringify(data)).not.toContain("REMETENTE-DO-VIZINHO");
  });

  it("o data.json do titular não leva appointment_notices", async () => {
    const data = await collectExportData(request);
    const arquivo = [...partesDoArquivoDoTitular(data, "BR")].join("");
    expect(arquivo).not.toContain("appointment_notices");
    expect(arquivo).not.toContain("REMETENTE-DO-TITULAR");
  });
});
