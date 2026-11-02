/**
 * A LISTA DE ESPERA É REDIGIDA NA ANONIMIZAÇÃO — E POR ISSO ENTRA NO ACESSO.
 *
 * A migration 0771 criou `calendar_waitlist` com o gatilho
 * `fn_redigir_espera_do_contato_anonimizado`, que zera `observacoes` quando o
 * contato vira anonimizado. A outra ponta da mesma regra é este export: o
 * texto que a casa apaga a pedido do titular tem de sair quando ele pede
 * acesso (Art. 18 II).
 *
 * `tests/unit/lgpd-exporta-o-que-redige.test.ts` cobra o PAR de tabelas lendo o
 * código-fonte — ele passa com um `.from("calendar_waitlist")` morto. Este
 * arquivo prova o comportamento: a linha do titular sai, a de outro contato e a
 * de outra organização não, e quem nunca pediu encaixe não ganha a chave.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { collectExportData } from "@/lib/lgpd/export-collector";

type Row = Record<string, unknown>;
const ORG = "tenant-a";
const OUTRA_ORG = "tenant-b";
const CONTACT = "contact-a";
const OUTRO_CONTACT = "contact-b";
const request = {
  organizationId: ORG,
  requestId: "export-1",
  contactId: CONTACT,
  externalCustomerId: null,
  pais: "BR",
};
let rows: Record<string, Row[]>;
let consultadas: string[];

/** Banco falso que aplica `eq` como o Postgres e projeta as colunas pedidas.
 *  Método do client que o coletor chame e este duble não conheça (`.or`, `.is`)
 *  passa sem filtrar — o `eq` de `organization_id`/`contact_id` já separa. */
function consulta(tabela: string): unknown {
  const alvo = new ReadQuery(tabela);
  const q: unknown = new Proxy(alvo, {
    get(obj, prop) {
      if (prop === "then")
        return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          obj.execute().then(ok, erro);
      const valor = (obj as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof valor === "function")
        return (...args: unknown[]) => {
          const r = valor.apply(obj, args);
          return r === obj ? q : r;
        };
      if (valor !== undefined) return valor;
      return () => q;
    },
  });
  return q;
}

class ReadQuery {
  columns = "";
  filters: [string, unknown][] = [];
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
  page: [number, number] = [0, 100000];
  ins: [string, unknown[]][] = [];
  async maybeSingle() {
    const result = await this.execute();
    return { ...result, data: result.data?.[0] ?? null };
  }
  then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }
  async execute() {
    consultadas.push(this.table);
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

const inscricao = (org: string, contato: string, extra: Row = {}): Row => ({
  id: `${org}-${contato}`,
  organization_id: org,
  contact_id: contato,
  event_type_id: "servico-a",
  owner_user_id: null,
  janelas: [{ dow: 1, inicio: "08:00", fim: "12:00" }],
  antecedencia_minima_horas: 24,
  valido_ate: null,
  urgencia: 2,
  status: "waiting",
  oferta_appointment_id: null,
  oferta_expira_em: null,
  ofertada_em: null,
  observacoes: "prefere manhã, falar com a Ana",
  created_by_kind: "contact",
  created_by_user_id: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...extra,
});

beforeEach(() => {
  consultadas = [];
  rows = {
    organizations: [
      { id: ORG, legal_name: "Clínica Teste", display_name: "Teste", dpo_email: null },
    ],
    contacts: [
      { id: CONTACT, organization_id: ORG, name: "Titular", created_at: "2026-01-01T00:00:00Z" },
    ],
    calendar_waitlist: [
      inscricao(ORG, CONTACT),
      inscricao(ORG, OUTRO_CONTACT, { id: "do-vizinho", observacoes: "VIZINHO" }),
      inscricao(OUTRA_ORG, CONTACT, { id: "da-outra-org", observacoes: "OUTRA-ORG" }),
    ],
  };
  mock.admin.mockReturnValue({ from: consulta });
});

describe("LGPD: a lista de espera no pedido de acesso (migration 0771)", () => {
  it("entrega a inscrição do titular, com a observação que a anonimização apaga", async () => {
    const payload = await collectExportData(request);
    expect(consultadas).toContain("calendar_waitlist");
    expect(payload.calendar_waitlist).toEqual([
      expect.objectContaining({
        id: `${ORG}-${CONTACT}`,
        event_type_id: "servico-a",
        status: "waiting",
        urgencia: 2,
        antecedencia_minima_horas: 24,
        janelas: [{ dow: 1, inicio: "08:00", fim: "12:00" }],
        observacoes: "prefere manhã, falar com a Ana",
      }),
    ]);
    // `owner_user_id` e `created_by_user_id` são a EQUIPE: não saem.
    expect(payload.calendar_waitlist?.[0]).not.toHaveProperty("owner_user_id");
    expect(payload.calendar_waitlist?.[0]).not.toHaveProperty("created_by_user_id");
  });

  it("inscrição de outro contato ou de outra organização nunca aparece", async () => {
    const payload = await collectExportData(request);
    const textos = JSON.stringify(payload.calendar_waitlist);
    expect(textos).not.toContain("VIZINHO");
    expect(textos).not.toContain("OUTRA-ORG");
    expect(payload.calendar_waitlist).toHaveLength(1);
  });

  it("titular sem inscrição: a seção não existe — a cópia de antes não ganha chave", async () => {
    rows.calendar_waitlist = [];
    const payload = await collectExportData(request);
    expect(payload.calendar_waitlist).toBeUndefined();
    // CONTROLE: a consulta foi feita e voltou vazia (não é um bloco que sumiu).
    expect(consultadas).toContain("calendar_waitlist");
  });
});
