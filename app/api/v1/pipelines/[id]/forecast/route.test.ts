/**
 * A PREVISÃO DA ROTA E DA TOOL MCP DEVOLVE AS DUAS PARCELAS — fatia 2 da #3602.
 *
 * O defeito medido na main: a rota `GET /api/v1/pipelines/[id]/forecast` e a
 * tool `crm_get_pipeline_forecast` devolviam só `value_cents` por balde, então
 * um contrato de 3.000 de setup + 500/mês era projetado como 3.000 e a
 * recorrência nova não aparecia. Depois do conserto, cada balde traz `unico` e
 * `recorrente_mensal` — e NADA traz a soma dos dois.
 *
 * A regra pura é medida em `lib/leads/previsao.test.ts`; aqui o que se prova é
 * o TRANSPORTE: o mesmo corte atravessa a rota REST e a tool MCP, e uma
 * organização sem recorrência vê `recorrente_mensal` ZERADO (não `null`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const PIPE = "44444444-4444-4444-8444-444444444444";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Linha = Record<string, unknown>;

/**
 * O mesmo dublê de client do vizinho `tests/unit/previsao-visibilidade`: aplica
 * `.eq` de verdade e resolve a consulta como thenable, que é o formato que o
 * `carregarPrevisao` consome.
 */
function clienteFake(linhasPorTabela: Record<string, Linha[]>) {
  const from = (tabela: string) => {
    let linhas = [...(linhasPorTabela[tabela] ?? [])];
    const q: {
      select: () => typeof q;
      order: () => typeof q;
      eq: (col: string, valor: unknown) => typeof q;
      maybeSingle: () => Promise<{ data: Linha | null; error: null }>;
      then: (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise<unknown>;
    } = {
      select: () => q,
      order: () => q,
      eq: (col, valor) => {
        linhas = linhas.filter((l) => l[col] === valor);
        return q;
      },
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (ok, erro) => Promise.resolve({ data: linhas, error: null }).then(ok, erro),
    };
    return q;
  };
  return { from } as never;
}

const PIPELINE_ROW = { id: PIPE, organization_id: ORG, settings: null };
const ETAPA_ROW = {
  id: "etapa-1",
  name: "Proposta",
  organization_id: ORG,
  pipeline_id: PIPE,
  is_won: false,
  is_lost: false,
  is_archived: false,
  win_probability: 50,
};

/** Os dois negócios do critério de aceite: setup de 3.000 e mensalidade de 500. */
const NEGOCIOS_COM_RECORRENCIA: Linha[] = [
  {
    id: "setup",
    organization_id: ORG,
    pipeline_id: PIPE,
    stage_id: "etapa-1",
    status: "open",
    value_cents: 300_000,
    currency: "BRL",
    expected_close_date: "2026-11-10",
    recurring_value_cents: null,
    recurring_period: null,
    recurring_months: null,
  },
  {
    id: "mensal",
    organization_id: ORG,
    pipeline_id: PIPE,
    stage_id: "etapa-1",
    status: "open",
    value_cents: 0,
    currency: "BRL",
    expected_close_date: "2026-11-20",
    recurring_value_cents: 50_000,
    recurring_period: "monthly",
    recurring_months: 12,
  },
];

/** Organização que nunca preencheu a fatia 1: o campo tem de vir ZERADO. */
const NEGOCIO_SEM_RECORRENCIA: Linha[] = [
  {
    id: "so-unico",
    organization_id: ORG,
    pipeline_id: PIPE,
    stage_id: "etapa-1",
    status: "open",
    value_cents: 100_000,
    currency: "BRL",
    expected_close_date: "2026-11-10",
    recurring_value_cents: null,
    recurring_period: null,
    recurring_months: null,
  },
];

function authOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
    },
    org: { orgId: ORG, name: "Org", role: "agent" as const },
  } as never);
}

function reqGet() {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/forecast`, {
    method: "GET",
  });
}

const ctx = { params: Promise.resolve({ id: PIPE }) };

type Parcela = { bruto_cents: number; ponderado_cents: number; n: number };
type FaixaEsperada = {
  moeda: string;
  mes: string;
  bruto_cents: number;
  ponderado_cents: number;
  n: number;
  unico: Parcela;
  recorrente_mensal: Parcela;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/forecast — as duas parcelas (#3602)", () => {
  it("mês com setup e mensalidade traz `unico` E `recorrente_mensal`, nunca a soma", async () => {
    authOk();
    vi.mocked(createClient).mockResolvedValue(
      clienteFake({
        crm_pipelines: [PIPELINE_ROW],
        crm_stages: [ETAPA_ROW],
        crm_leads: NEGOCIOS_COM_RECORRENCIA,
      }),
    );

    const { GET } = await import("@/app/api/v1/pipelines/[id]/forecast/route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);

    const bruto = (await res.json()) as { data: { meses: FaixaEsperada[] } };
    expect(bruto.data.meses).toEqual([
      {
        moeda: "BRL",
        mes: "2026-11",
        bruto_cents: 300_000,
        ponderado_cents: 150_000,
        n: 2,
        unico: { bruto_cents: 300_000, ponderado_cents: 150_000, n: 2 },
        recorrente_mensal: { bruto_cents: 50_000, ponderado_cents: 25_000, n: 1 },
      },
    ]);

    // O defeito da issue é a soma: 350.000/175.000 não pode existir em campo
    // nenhum da resposta.
    const json = JSON.stringify(bruto.data.meses);
    expect(json).not.toContain("350000");
    expect(json).not.toContain("175000");
  });

  it("organização sem recorrência: `recorrente_mensal` ZERADO, não `null`", async () => {
    authOk();
    vi.mocked(createClient).mockResolvedValue(
      clienteFake({
        crm_pipelines: [PIPELINE_ROW],
        crm_stages: [ETAPA_ROW],
        crm_leads: NEGOCIO_SEM_RECORRENCIA,
      }),
    );

    const { GET } = await import("@/app/api/v1/pipelines/[id]/forecast/route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as { data: { meses: FaixaEsperada[] } };

    const mes = body.data.meses[0]!;
    expect(mes.unico).toEqual({ bruto_cents: 100_000, ponderado_cents: 50_000, n: 1 });
    expect(mes.recorrente_mensal).not.toBeNull();
    expect(mes.recorrente_mensal).toEqual({ bruto_cents: 0, ponderado_cents: 0, n: 0 });
  });
});

describe("tool MCP crm_get_pipeline_forecast — a mesma regra da rota (#3602)", () => {
  it("o handler devolve as duas parcelas por balde, com os mesmos nomes da rota", async () => {
    const supabase = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_ROW],
      crm_leads: NEGOCIOS_COM_RECORRENCIA,
    });

    const { crmGetPipelineForecast } = await import("@/lib/mcp/tools/pipelines");
    const mcpCtx: McpContext = {
      organizationId: ORG,
      role: "agent",
      actor: { type: "user", id: USER },
      apiTokenId: "tok-1",
      requestId: "req-1",
      supabase: supabase as unknown as SupabaseClient,
    };

    const r = (await crmGetPipelineForecast.handler({ pipeline_id: PIPE }, mcpCtx)) as {
      meses: FaixaEsperada[];
      totais: Array<{ unico: Parcela; recorrente_mensal: Parcela }>;
    };

    expect(r.meses[0]?.unico).toEqual({ bruto_cents: 300_000, ponderado_cents: 150_000, n: 2 });
    expect(r.meses[0]?.recorrente_mensal).toEqual({
      bruto_cents: 50_000,
      ponderado_cents: 25_000,
      n: 1,
    });
    expect(r.totais[0]?.unico.bruto_cents).toBe(300_000);
    expect(r.totais[0]?.recorrente_mensal.bruto_cents).toBe(50_000);
    expect(JSON.stringify(r)).not.toContain("350000");
  });
});
