import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { collectExportData } from "@/lib/lgpd/export-collector";
import { copiaDoTitular } from "@/lib/lgpd/copia-do-titular";

type Row = Record<string, unknown>;
const ORG = "org-a", CONTACT = "contato-a";
const TABELA = "meta_ctwa_click_dispatches";
const pedido = { organizationId: ORG, requestId: "pedido-sintetico", contactId: CONTACT, externalCustomerId: null };
let rows: Record<string, Row[]>;
let falha: { message: string } | null;
let falhasPorTabela: Record<string, { code: string; message: string }>;
const leituras: Array<{ tabela: string; colunas: string; ordem: string; faixa: [number, number]; filtros: Array<[string, unknown]>; incluidos: Array<[string, unknown[]]> }> = [];

/** O transporte aplica os filtros/páginas/colunas pedidos pelo coletor real. */
class Consulta {
  colunas = "";
  ordem = "";
  filtros: Array<[string, unknown]> = [];
  incluidos: Array<[string, unknown[]]> = [];
  faixa: [number, number] = [0, 999];
  constructor(readonly tabela: string) {}
  select(colunas: string) { this.colunas = colunas; return this; }
  eq(campo: string, valor: unknown) { this.filtros.push([campo, valor]); return this; }
  in(campo: string, valores: unknown[]) { this.incluidos.push([campo, valores]); return this; }
  order(campo: string) { this.ordem = campo; return this; }
  limit(total: number) { this.faixa = [0, total - 1]; return this; }
  range(inicio: number, fim: number) { this.faixa = [inicio, fim]; return this; }
  or() { return this; }
  async maybeSingle() { const r = await this.executar(); return { ...r, data: r.data?.[0] ?? null }; }
  then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) { return this.executar().then(resolve, reject); }
  async executar() {
    leituras.push({ tabela: this.tabela, colunas: this.colunas, ordem: this.ordem, faixa: this.faixa, filtros: this.filtros, incluidos: this.incluidos });
    if (falhasPorTabela[this.tabela]) return { data: null, error: falhasPorTabela[this.tabela] };
    if (this.tabela === TABELA && falha) return { data: null, error: falha };
    const dados = (rows[this.tabela] ?? [])
      .filter((r) => this.filtros.every(([campo, valor]) => r[campo] === valor))
      .filter((r) => this.incluidos.every(([campo, valores]) => valores.includes(r[campo])))
      .sort((a, b) => String(a[this.ordem]).localeCompare(String(b[this.ordem])))
      .slice(this.faixa[0], this.faixa[1] + 1)
      .map((r) => Object.fromEntries(this.colunas.split(",").map((c) => c.trim()).map((c) => [c, r[c]])));
    return { data: dados, error: null };
  }
}

function clique(id: string, organization_id = ORG, contact_id = CONTACT): Row {
  return {
    id, organization_id, contact_id, ctwa_clid: `clique-${id}`,
    captured_at: "2026-10-26T12:00:00Z", status: "sent", attempted_at: "2026-10-26T12:00:01Z", created_at: "2026-10-26T12:00:00Z",
    first_message_id: "mensagem-interna", event_id: "evento-interno", activation_at_capture: "configuracao-interna",
    claim_token: "PRIVADO-TOKEN", claimed_until: "PRIVADO-LEASE", reason: "PRIVADO-MOTIVO", detail: "PRIVADO-DETALHE",
  };
}

beforeEach(() => {
  falha = null; falhasPorTabela = {}; leituras.length = 0;
  rows = {
    organizations: [{ id: ORG, legal_name: "Empresa sintética", display_name: "Sintética", country: "BR", settings: {} }],
    contacts: [{ id: CONTACT, organization_id: ORG, name: "Pessoa sintética", phone_number: null, wa_lid: null, tags: [], custom_fields: {} }],
  };
  mock.admin.mockReturnValue({ from: (tabela: string) => new Consulta(tabela) });
});

describe("coleta CTWA com honorários opcionais", () => {
  const LEAD = "lead-do-titular";
  const CONTRATO = "contrato-do-titular";
  const mensagem = "Could not find the table 'public.honorarios_contratos' in the schema cache";

  beforeEach(() => {
    rows.crm_leads = [
      { id: LEAD, organization_id: ORG, contact_id: CONTACT },
      { id: "lead-de-outro-contato", organization_id: ORG, contact_id: "contato-b" },
      { id: "lead-de-outro-tenant", organization_id: "org-b", contact_id: CONTACT },
    ];
    rows[TABELA] = [clique("proprio")];
  });

  it.each(["42P01", "PGRST205"])("omite somente o módulo ausente (%s) e conserva a seção CTWA", async (code) => {
    falhasPorTabela.honorarios_contratos = { code, message: mensagem };
    const payload = await collectExportData(pedido);
    expect(payload.honorarios_contratos).toEqual([]);
    expect(payload.honorarios_parcelas).toEqual([]);
    expect(payload.meta_ctwa_click_dispatches?.[0]?.ctwa_clid).toBe("clique-proprio");
    expect(leituras.some((l) => l.tabela === "honorarios_parcelas")).toBe(false);
  });

  it.each(["42501", "PGRST204", "57014", "XX000"])("não oculta %s mesmo com mensagem de tabela ausente", async (code) => {
    falhasPorTabela.honorarios_contratos = { code, message: mensagem };
    await expect(collectExportData(pedido)).rejects.toThrow("honorarios_contratos_load_failed");
  });

  it("PGRST205 em tabela obrigatória continua impedindo o export", async () => {
    falhasPorTabela[TABELA] = { code: "PGRST205", message: mensagem };
    await expect(collectExportData(pedido)).rejects.toEqual(falhasPorTabela[TABELA]);
  });

  it.each(["42P01", "PGRST205"])("não entrega módulo parcialmente instalado se faltar parcelas (%s)", async (code) => {
    rows.honorarios_contratos = [{ id: CONTRATO, organization_id: ORG, lead_id: LEAD }];
    falhasPorTabela.honorarios_parcelas = { code, message: mensagem };
    await expect(collectExportData(pedido)).rejects.toThrow("honorarios_parcelas_load_failed");
  });

  it("módulo presente conserva contrato/parcelas apenas da organização e dos leads do titular", async () => {
    rows.honorarios_contratos = [
      { id: CONTRATO, organization_id: ORG, lead_id: LEAD, modelo: "fixo" },
      { id: "contrato-outro-contato", organization_id: ORG, lead_id: "lead-de-outro-contato" },
      { id: "contrato-outro-tenant", organization_id: "org-b", lead_id: LEAD },
    ];
    rows.honorarios_parcelas = [
      { id: "parcela-propria", organization_id: ORG, contrato_id: CONTRATO, numero: 1 },
      { id: "parcela-outro-contato", organization_id: ORG, contrato_id: "contrato-outro-contato", numero: 1 },
      { id: "parcela-outro-tenant", organization_id: "org-b", contrato_id: CONTRATO, numero: 1 },
    ];
    const payload = await collectExportData(pedido);
    expect(payload.honorarios_contratos.map((c) => c.id)).toEqual([CONTRATO]);
    expect(payload.honorarios_parcelas.map((p) => p.id)).toEqual(["parcela-propria"]);
    expect(leituras.find((l) => l.tabela === "honorarios_contratos")).toMatchObject({ filtros: [["organization_id", ORG]], incluidos: [["lead_id", [LEAD]]] });
    expect(leituras.find((l) => l.tabela === "honorarios_parcelas")).toMatchObject({ filtros: [["organization_id", ORG]], incluidos: [["contrato_id", [CONTRATO]]] });
  });
});

describe("acesso LGPD aos cliques CTWA", () => {
  it("entrega somente cliques do titular e não leva tokens ou detalhes internos na cópia", async () => {
    rows[TABELA] = [clique("proprio"), clique("outro-contato", ORG, "contato-b"), clique("outro-tenant", "org-b", CONTACT)];
    const payload = await collectExportData(pedido);
    const esperado = [{ ctwa_clid: "clique-proprio", captured_at: "2026-10-26T12:00:00Z", status: "sent", attempted_at: "2026-10-26T12:00:01Z", created_at: "2026-10-26T12:00:00Z" }];
    expect(payload.meta_ctwa_click_dispatches).toEqual(esperado);
    expect(copiaDoTitular(payload, "BR").meta_ctwa_click_dispatches).toEqual(esperado);
    expect(JSON.stringify(payload.meta_ctwa_click_dispatches)).not.toMatch(/PRIVADO|outro-|claim|event_id|first_message_id|activation_at_capture/);
    expect(leituras.filter((l) => l.tabela === TABELA)[0]?.colunas).toBe("ctwa_clid, captured_at, status, attempted_at, created_at");
  });

  it("pagina além de 500 por chave única mesmo com datas empatadas", async () => {
    rows[TABELA] = Array.from({ length: 501 }, (_, i) => clique(String(i).padStart(4, "0"))).reverse();
    const payload = await collectExportData(pedido);
    expect(payload.meta_ctwa_click_dispatches).toHaveLength(501);
    expect(payload.meta_ctwa_click_dispatches?.at(-1)?.ctwa_clid).toBe("clique-0500");
    expect(leituras.filter((l) => l.tabela === TABELA).map((l) => [l.ordem, l.faixa])).toEqual([["id", [0, 499]], ["id", [500, 999]]]);
  });

  it("falha alto em vez de entregar vazio se a consulta do clique falhar", async () => {
    falha = { message: "consulta_sintetica_recusada" };
    await expect(collectExportData(pedido)).rejects.toEqual(falha);
  });

  it("preserva o formato anterior vazio e não consulta cliques sem identificador", async () => {
    expect(await collectExportData(pedido)).not.toHaveProperty(TABELA);
    leituras.length = 0;
    expect(await collectExportData({ ...pedido, contactId: null })).not.toHaveProperty(TABELA);
    expect(leituras.map((l) => l.tabela)).toEqual(["organizations"]);
  });
});
