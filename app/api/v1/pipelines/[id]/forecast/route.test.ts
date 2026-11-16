/**
 * A previsão do funil conta a MENSALIDADE NOVA (issue #3602, fatia da previsão).
 *
 * A régua pura é `lib/leads/previsao.ts` e os casos de negócio moram no teste
 * dela (`lib/leads/previsao.test.ts`). Aqui o que se mede é o TRANSPORTE: a rota
 * REST e a tool MCP entregam as duas parcelas por balde — `unico` e
 * `recorrente_mensal`, os mesmos nomes de `lib/metrics/valores-do-periodo.ts` —
 * e entregam `recorrente_mensal` ZERADA (nunca `null`) numa organização sem
 * recorrência, para nenhum consumidor somar `null` com número.
 *
 * A tool é medida junto porque ela chama a MESMA `carregarPrevisao`: duas
 * respostas com vocabulários diferentes para a mesma conta divergem no primeiro
 * ajuste.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const PIPE = "44444444-4444-4444-8444-444444444444";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Linha = Record<string, unknown>;

interface Chamada {
  metodo: string;
  args: unknown[];
}

/**
 * Client falso com a cadeia do PostgREST (select/eq/order/range/maybeSingle) e
 * `then`, para o `await` da rota funcionar. O `.eq` filtra DE VERDADE: linha
 * sem o campo seria descartada, e o teste mediria o dublê em vez da rota.
 *
 * Desde a #4322 ele também se comporta como o PostgREST onde o defeito mora:
 *  - `maxRows` corta CADA resposta, sem erro nenhum (`supabase/config.toml`);
 *  - `.range()` pagina, e `select(..., { count: "exact" })` devolve o `count`
 *    do total JÁ filtrado, antes do corte — é o que o `lerPaginado` usa para
 *    provar o fim;
 *  - `.order()` ordena DE VERDADE (sem ele o pedaço seria arbitrário);
 *  - `.eq("crm_leads.pipeline_id", x)` filtra pelo EMBED `crm_leads!inner`: a
 *    linha de score carrega `crm_leads: { pipeline_id, status }` e a que não
 *    bate sai da resposta, como no `!inner`.
 */
function clienteFake(linhasPorTabela: Record<string, Linha[]>, opcoes: { maxRows?: number } = {}) {
  const consultas: Array<{ tabela: string; colunas: string; chamadas: Chamada[] }> = [];

  const valorDe = (linha: Linha, coluna: string): unknown => {
    const [cabeca, ...resto] = coluna.split(".");
    let atual: unknown = linha[cabeca as string];
    for (const parte of resto) {
      atual = (atual as Record<string, unknown> | null | undefined)?.[parte];
    }
    return atual;
  };

  const from = (tabela: string) => {
    let linhas = [...(linhasPorTabela[tabela] ?? [])];
    let colunas = "";
    let contar = false;
    let faixa: [number, number] | null = null;
    const ordens: string[] = [];
    const chamadas: Chamada[] = [];

    const executar = () => {
      const ordenadas = [...linhas].sort((a, b) => {
        for (const col of ordens) {
          const x = valorDe(a, col) as string | number;
          const y = valorDe(b, col) as string | number;
          if (x === y) continue;
          return x < y ? -1 : 1;
        }
        return 0;
      });
      const total = ordenadas.length;
      let pagina = faixa ? ordenadas.slice(faixa[0], faixa[1] + 1) : ordenadas;
      if (opcoes.maxRows !== undefined) pagina = pagina.slice(0, opcoes.maxRows);
      consultas.push({ tabela, colunas, chamadas });
      return { data: pagina, error: null, count: contar ? total : null };
    };

    const q: {
      select: (cols?: string, opts?: { count?: string }) => typeof q;
      order: (col: string) => typeof q;
      range: (de: number, ate: number) => typeof q;
      eq: (col: string, valor: unknown) => typeof q;
      maybeSingle: () => Promise<{ data: Linha | null; error: null }>;
      then: (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise<unknown>;
    } = {
      select: (cols, opts) => {
        chamadas.push({ metodo: "select", args: [cols, opts] });
        colunas = cols ?? "";
        contar = opts?.count === "exact";
        return q;
      },
      order: (col) => {
        chamadas.push({ metodo: "order", args: [col] });
        ordens.push(col);
        return q;
      },
      range: (de, ate) => {
        chamadas.push({ metodo: "range", args: [de, ate] });
        faixa = [de, ate];
        return q;
      },
      eq: (col, valor) => {
        chamadas.push({ metodo: "eq", args: [col, valor] });
        linhas = linhas.filter((l) => valorDe(l, col) === valor);
        return q;
      },
      maybeSingle: async () => {
        consultas.push({ tabela, colunas, chamadas });
        return { data: linhas[0] ?? null, error: null };
      },
      then: (ok, erro) => Promise.resolve(executar()).then(ok, erro),
    };
    return q;
  };

  return { client: { from } as never, consultas };
}

const PIPELINE_ROW = { id: PIPE, organization_id: ORG, settings: null };
const ETAPA_CALIBRADA = {
  id: "qualificada",
  name: "Qualificada",
  organization_id: ORG,
  pipeline_id: PIPE,
  is_won: false,
  is_lost: false,
  is_archived: false,
  win_probability: 50,
};

/** Cenário do critério: setup de R$ 3.000 e um contrato de R$ 500/mês, ambos a 50%. */
const DOIS_NEGOCIOS = [
  {
    id: "setup",
    organization_id: ORG,
    pipeline_id: PIPE,
    stage_id: "qualificada",
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
    stage_id: "qualificada",
    status: "open",
    value_cents: 0,
    currency: "BRL",
    expected_close_date: "2026-11-20",
    recurring_value_cents: 50_000,
    recurring_period: "monthly",
    recurring_months: 12,
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
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/forecast`, { method: "GET" });
}

const ctxRota = { params: Promise.resolve({ id: PIPE }) };

interface CorpoDaPrevisao {
  data: {
    fonte: string;
    meses: Array<{
      moeda: string;
      mes: string;
      bruto_cents: number;
      ponderado_cents: number;
      n: number;
      unico: { bruto_cents: number; ponderado_cents: number };
      recorrente_mensal: { bruto_cents: number; ponderado_cents: number };
    }>;
    totais: Array<{
      moeda: string;
      bruto_cents: number;
      ponderado_cents: number;
      n: number;
      unico: { bruto_cents: number; ponderado_cents: number };
      recorrente_mensal: { bruto_cents: number; ponderado_cents: number };
    }>;
    sem_data: Array<{
      moeda: string;
      unico: { bruto_cents: number; ponderado_cents: number };
      recorrente_mensal: { bruto_cents: number; ponderado_cents: number };
    }>;
    recorrencia_nao_mensal: Array<{ moeda: string; bruto_cents: number; n: number }>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/forecast — as duas parcelas (#3602)", () => {
  it("⭐ devolve unico 300.000/150.000 e recorrente_mensal 50.000/25.000 — e nenhum campo com 350.000", async () => {
    authOk();
    const sessao = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_CALIBRADA],
      crm_leads: DOIS_NEGOCIOS,
    });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctxRota);
    expect(res.status).toBe(200);

    const corpoCru = await res.clone().text();
    const body = JSON.parse(corpoCru) as CorpoDaPrevisao;
    const mes = body.data.meses[0];
    expect(mes?.mes).toBe("2026-11");
    expect(mes?.unico).toEqual({ bruto_cents: 300_000, ponderado_cents: 150_000 });
    expect(mes?.recorrente_mensal).toEqual({ bruto_cents: 50_000, ponderado_cents: 25_000 });
    expect(body.data.totais[0]?.unico).toEqual({
      bruto_cents: 300_000,
      ponderado_cents: 150_000,
    });
    expect(body.data.totais[0]?.recorrente_mensal).toEqual({
      bruto_cents: 50_000,
      ponderado_cents: 25_000,
    });

    // Retrocompatibilidade: os campos planos são SÓ o valor único.
    expect(mes?.bruto_cents).toBe(300_000);
    expect(mes?.ponderado_cents).toBe(150_000);

    // O JSON inteiro não carrega a soma das duas parcelas.
    expect(corpoCru).not.toContain("350000");
    expect(corpoCru).not.toContain("175000");
  });

  it("a leitura pede as três colunas da recorrência ao banco (sem elas não há segunda parcela)", async () => {
    authOk();
    const sessao = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_CALIBRADA],
      crm_leads: DOIS_NEGOCIOS,
    });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("./route");
    await GET(reqGet(), ctxRota);

    const colunasDosNegocios = sessao.consultas.find((c) => c.tabela === "crm_leads")?.colunas ?? "";
    expect(colunasDosNegocios).toContain("recurring_value_cents");
    expect(colunasDosNegocios).toContain("recurring_period");
    expect(colunasDosNegocios).toContain("recurring_months");
    // O valor único continua sendo lido: a primeira parcela não muda.
    expect(colunasDosNegocios).toContain("value_cents");
  });

  it("organização SEM recorrência: recorrente_mensal vem ZERADA (não null), e a resposta continua legível", async () => {
    authOk();
    const sessao = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_CALIBRADA],
      crm_leads: [
        {
          id: "so-unico",
          organization_id: ORG,
          pipeline_id: PIPE,
          stage_id: "qualificada",
          status: "open",
          value_cents: 100_000,
          currency: "BRL",
          expected_close_date: "2026-11-10",
          // A coluna existe e vem nula — é o que o PostgREST devolve hoje.
          recurring_value_cents: null,
          recurring_period: null,
          recurring_months: null,
        },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctxRota);
    const body = (await res.json()) as CorpoDaPrevisao;

    expect(body.data.totais[0]?.unico).toEqual({ bruto_cents: 100_000, ponderado_cents: 50_000 });
    expect(body.data.totais[0]?.recorrente_mensal).toEqual({
      bruto_cents: 0,
      ponderado_cents: 0,
    });
    expect(body.data.meses[0]?.recorrente_mensal).toEqual({
      bruto_cents: 0,
      ponderado_cents: 0,
    });
    expect(body.data.recorrencia_nao_mensal).toEqual([]);
    // Zero é número; `null` seria a ausência que o consumidor somaria como NaN.
    expect(body.data.totais[0]?.recorrente_mensal.bruto_cents).not.toBeNull();
  });

  it("negócio sem data prevista: a recorrência aparece no balde 'sem data'", async () => {
    authOk();
    const sessao = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_CALIBRADA],
      crm_leads: [
        {
          id: "sem-data",
          organization_id: ORG,
          pipeline_id: PIPE,
          stage_id: "qualificada",
          status: "open",
          value_cents: 0,
          currency: "BRL",
          expected_close_date: null,
          recurring_value_cents: 80_000,
          recurring_period: "monthly",
          recurring_months: null,
        },
      ],
    });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctxRota);
    const body = (await res.json()) as CorpoDaPrevisao;

    expect(body.data.meses).toEqual([]);
    expect(body.data.sem_data).toHaveLength(1);
    expect(body.data.sem_data[0]?.recorrente_mensal).toEqual({
      bruto_cents: 80_000,
      ponderado_cents: 40_000,
    });
  });

  it("funil de outra organização continua 404 — a fatia nova não abre a porta", async () => {
    authOk();
    const sessao = clienteFake({ crm_pipelines: [], crm_stages: [], crm_leads: [] });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("./route");
    expect((await GET(reqGet(), ctxRota)).status).toBe(404);
  });

  it("sem papel suficiente → a resposta do requireRole, sem abrir client", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente.", 403, {}),
    });

    const { GET } = await import("./route");
    expect((await GET(reqGet(), ctxRota)).status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("crm_get_pipeline_forecast — a tool MCP entrega as MESMAS duas parcelas", () => {
  it("⭐ handler devolve unico e recorrente_mensal por balde, com os nomes de valores-do-periodo", async () => {
    const sessao = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_CALIBRADA],
      crm_leads: DOIS_NEGOCIOS,
    });

    const ctxMcp = {
      organizationId: ORG,
      requestId: "req-3602",
      supabase: sessao.client,
    } as unknown as McpContext;

    const { crmGetPipelineForecast } = await import("@/lib/mcp/tools/pipelines");
    const resultado = (await crmGetPipelineForecast.handler(
      { pipeline_id: PIPE },
      ctxMcp,
    )) as unknown as CorpoDaPrevisao["data"];

    expect(resultado.meses[0]?.unico).toEqual({
      bruto_cents: 300_000,
      ponderado_cents: 150_000,
    });
    expect(resultado.meses[0]?.recorrente_mensal).toEqual({
      bruto_cents: 50_000,
      ponderado_cents: 25_000,
    });
    // A tool lê o MESMO select da rota: sem as colunas, a parcela viria zerada
    // e o modelo responderia "não há recorrência" para quem tem.
    const colunas = sessao.consultas.find((c) => c.tabela === "crm_leads")?.colunas ?? "";
    expect(colunas).toContain("recurring_value_cents");
  });

  it("organização sem recorrência: a tool devolve recorrente_mensal zerada, nunca ausente", async () => {
    const sessao = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_CALIBRADA],
      crm_leads: [
        {
          id: "so-unico",
          organization_id: ORG,
          pipeline_id: PIPE,
          stage_id: "qualificada",
          status: "open",
          value_cents: 100_000,
          currency: "BRL",
          expected_close_date: "2026-11-10",
        },
      ],
    });

    const ctxMcp = {
      organizationId: ORG,
      requestId: "req-3602",
      supabase: sessao.client,
    } as unknown as McpContext;

    const { crmGetPipelineForecast } = await import("@/lib/mcp/tools/pipelines");
    const resultado = (await crmGetPipelineForecast.handler(
      { pipeline_id: PIPE },
      ctxMcp,
    )) as unknown as CorpoDaPrevisao["data"];

    expect(resultado.totais[0]?.recorrente_mensal).toEqual({
      bruto_cents: 0,
      ponderado_cents: 0,
    });
  });
});
