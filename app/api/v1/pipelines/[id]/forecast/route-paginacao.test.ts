/**
 * A PREVISÃO DO FUNIL NÃO PODE MAIS CORTAR CALADO (#4322).
 *
 * `carregarPrevisao` lia os negócios abertos do funil SEM `.range()` e os scores
 * da organização INTEIRA sem filtro de funil e sem `.order()`. O PostgREST corta
 * toda resposta em `max_rows` (`supabase/config.toml: max_rows = 1000`) sem
 * devolver erro: acima de mil negócios abertos a previsão somava um pedaço
 * arbitrário e a tela a apresentava como a carteira inteira — o mesmo defeito do
 * quadro do funil (#4321, consertado no #4331 com `lerPaginado`).
 *
 * As réguas deste arquivo:
 *
 *  (a) a leitura dos negócios é paginada, filtra a organização e ordena por
 *      `id` (ordem estável entre as páginas, imune a card arrastado);
 *  (b) 1.200 negócios abertos voltam TODOS na soma, e o corpo não ganha campo;
 *  (c) com a fonte `ia_quando_houver`, a leitura dos scores é do FUNIL (embed
 *      `crm_leads!inner`), da organização, ordenada por `lead_id` e paginada —
 *      mais de mil scores do funil entram todos, e os de OUTRO funil não gastam
 *      páginas nem acusam corte falso;
 *  (d) quando o fim não pode ser provado, a resposta AVISA (`truncado` no corpo
 *      e `X-Previsao-Truncada`) em vez de fingir que veio tudo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const PIPE = "44444444-4444-4444-8444-444444444444";
const OUTRO_FUNIL = "55555555-5555-4555-8555-555555555555";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Linha = Record<string, unknown>;
interface Chamada {
  metodo: string;
  args: unknown[];
}

/**
 * Dublê do PostgREST onde o defeito mora: `maxRows` corta CADA resposta sem
 * erro; `.range()` pagina; `select(..., { count: "exact" })` devolve o total JÁ
 * filtrado (antes do corte); `.order()` ordena de verdade; e `.eq("a.b", x)`
 * filtra pelo embed `a` da linha, como o `!inner`. Toda chamada fica registrada.
 */
function banco(linhasPorTabela: Record<string, Linha[]>, maxRows = 1000) {
  const consultas: Array<{ tabela: string; chamadas: Chamada[] }> = [];

  const valorDe = (linha: Linha, coluna: string): unknown => {
    let atual: unknown = linha;
    for (const parte of coluna.split(".")) {
      atual = (atual as Record<string, unknown> | null | undefined)?.[parte];
    }
    return atual;
  };

  const from = (tabela: string) => {
    let linhas = [...(linhasPorTabela[tabela] ?? [])];
    let contar = false;
    let faixa: [number, number] | null = null;
    const ordens: string[] = [];
    const chamadas: Chamada[] = [];
    consultas.push({ tabela, chamadas });

    const q = {
      select: (cols?: string, opts?: { count?: string }) => {
        chamadas.push({ metodo: "select", args: [cols, opts] });
        contar = opts?.count === "exact";
        return q;
      },
      order: (col: string) => {
        chamadas.push({ metodo: "order", args: [col] });
        ordens.push(col);
        return q;
      },
      range: (de: number, ate: number) => {
        chamadas.push({ metodo: "range", args: [de, ate] });
        faixa = [de, ate];
        return q;
      },
      eq: (col: string, valor: unknown) => {
        chamadas.push({ metodo: "eq", args: [col, valor] });
        linhas = linhas.filter((l) => valorDe(l, col) === valor);
        return q;
      },
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => {
        const ordenadas = [...linhas].sort((a, b) => {
          for (const col of ordens) {
            const x = valorDe(a, col) as string | number;
            const y = valorDe(b, col) as string | number;
            if (x !== y) return x < y ? -1 : 1;
          }
          return 0;
        });
        const pagina = (faixa ? ordenadas.slice(faixa[0], faixa[1] + 1) : ordenadas).slice(
          0,
          maxRows,
        );
        return Promise.resolve({
          data: pagina,
          error: null,
          count: contar ? ordenadas.length : null,
        }).then(ok, erro);
      },
    };
    return q;
  };

  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return {
    consultas,
    /** A leitura paginada de uma tabela: a que usa `.range()`. */
    leituraPaginada(tabela: string): Chamada[] {
      const achada = consultas.find(
        (c) => c.tabela === tabela && c.chamadas.some((m) => m.metodo === "range"),
      );
      if (!achada) throw new Error(`a rota não emitiu leitura paginada de ${tabela}`);
      return achada.chamadas;
    },
  };
}

const argDe = (chamadas: Chamada[], metodo: string) =>
  chamadas.filter((c) => c.metodo === metodo).map((c) => c.args);

const funil = (fonte?: string) => ({
  id: PIPE,
  organization_id: ORG,
  settings: fonte ? { previsao: { fonte } } : null,
});

const etapa = {
  id: "e1",
  name: "Qualificada",
  organization_id: ORG,
  pipeline_id: PIPE,
  is_won: false,
  is_lost: false,
  is_archived: false,
  win_probability: 50,
  position: 1000,
};

/** Negócio aberto de R$ 100,00, a 50% pela etapa, com data no mês 2026-11. */
const negocio = (i: number, over: Linha = {}): Linha => ({
  id: `n${String(i).padStart(5, "0")}`,
  organization_id: ORG,
  pipeline_id: PIPE,
  stage_id: "e1",
  status: "open",
  position_in_stage: (i % 37) * 10,
  value_cents: 10_000,
  currency: "BRL",
  expected_close_date: "2026-11-15",
  recurring_value_cents: null,
  recurring_period: null,
  recurring_months: null,
  ...over,
});

/** Score de um negócio, com o embed que o `crm_leads!inner` traz. */
const score = (
  leadId: string,
  prob: number,
  over: { org?: string; funil?: string; status?: string } = {},
): Linha => ({
  lead_id: leadId,
  organization_id: over.org ?? ORG,
  ai_probability: prob,
  crm_leads: { pipeline_id: over.funil ?? PIPE, status: over.status ?? "open" },
});

interface Corpo {
  data: {
    totais: Array<{
      n: number;
      bruto_cents: number;
      ponderado_cents: number;
    }>;
    truncado?: true;
  };
}

async function lerPrevisao(): Promise<{ status: number; corpo: Corpo; headers: Headers }> {
  const { GET } = await import("./route");
  const res = await GET(
    new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/forecast`, { method: "GET" }),
    { params: Promise.resolve({ id: PIPE }) },
  );
  return { status: res.status, corpo: (await res.json()) as Corpo, headers: res.headers };
}

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe("GET /forecast — a leitura não corta calado (#4322)", () => {
  it("⭐ (a) a leitura dos negócios é paginada, da organização, em ordem estável", async () => {
    const reg = banco({
      crm_pipelines: [funil()],
      crm_stages: [etapa],
      crm_leads: [negocio(1)],
    });

    const { status } = await lerPrevisao();
    expect(status).toBe(200);

    const chamadas = reg.leituraPaginada("crm_leads");
    expect(argDe(chamadas, "eq")).toContainEqual(["organization_id", ORG]);
    expect(argDe(chamadas, "eq")).toContainEqual(["pipeline_id", PIPE]);
    expect(argDe(chamadas, "eq")).toContainEqual(["status", "open"]);
    // Só `id`: a soma não tem ordem de exibição, e ordenar por posição deixaria
    // um card arrastado durante a leitura trocar de página e sumir da soma.
    expect(argDe(chamadas, "order").map((a) => a[0])).toEqual(["id"]);
    expect(argDe(chamadas, "range")[0]).toEqual([0, 999]);
    // O `count` exato da primeira página é o que prova onde a carteira acaba.
    expect(argDe(chamadas, "select")[0]?.[1]).toEqual({ count: "exact" });
  });

  it("⭐ (b) 1.200 negócios abertos entram TODOS na soma, sem aviso", async () => {
    const leads = Array.from({ length: 1200 }, (_, i) => negocio(i));
    banco({ crm_pipelines: [funil()], crm_stages: [etapa], crm_leads: leads });

    const { status, corpo, headers } = await lerPrevisao();
    expect(status).toBe(200);

    // O corte silencioso de 1.000 é o defeito: 200 negócios (R$ 20 mil
    // brutos) sumiam da previsão sem erro nenhum.
    expect(corpo.data.totais[0]?.n).toBe(1200);
    expect(corpo.data.totais[0]?.bruto_cents).toBe(1200 * 10_000);
    expect(corpo.data.totais[0]?.ponderado_cents).toBe(1200 * 5_000);
    expect(corpo.data.truncado).toBeUndefined();
    expect(headers.get("X-Previsao-Truncada")).toBeNull();
  });

  it("⭐ (c) com a IA como fonte, os scores são do FUNIL e mais de mil entram todos", async () => {
    // 1.100 negócios, todos com score 100: pela etapa seriam 50%, pela IA 100%.
    // Lendo só 1.000 scores, 100 negócios cairiam em silêncio para os 50%.
    const leads = Array.from({ length: 1100 }, (_, i) => negocio(i));
    const doFunil = leads.map((l) => score(l.id as string, 100));
    // 4.500 scores de OUTRO funil e 1 de outra organização: o total da
    // organização (5.601) estoura as 5 páginas, o do funil (1.100) não.
    const deFora = Array.from({ length: 4500 }, (_, i) =>
      score(`x${String(i).padStart(5, "0")}`, 10, { funil: OUTRO_FUNIL }),
    );
    const deOutraOrg = score("y00000", 10, { org: OUTRA_ORG });

    const reg = banco({
      crm_pipelines: [funil("ia_quando_houver")],
      crm_stages: [etapa],
      crm_leads: leads,
      crm_lead_scores: [...doFunil, ...deFora, deOutraOrg],
    });

    const { status, corpo, headers } = await lerPrevisao();
    expect(status).toBe(200);

    expect(corpo.data.totais[0]?.n).toBe(1100);
    expect(corpo.data.totais[0]?.ponderado_cents).toBe(1100 * 10_000);
    expect(corpo.data.truncado).toBeUndefined();
    expect(headers.get("X-Previsao-Truncada")).toBeNull();

    // A forma da consulta: funil e organização no filtro, ordem por `lead_id`
    // (a chave primária) e `count` exato para provar o fim.
    const chamadas = reg.leituraPaginada("crm_lead_scores");
    const colunas = String(argDe(chamadas, "select")[0]?.[0] ?? "");
    expect(colunas).toContain("crm_leads!inner");
    expect(argDe(chamadas, "eq")).toContainEqual(["organization_id", ORG]);
    expect(argDe(chamadas, "eq")).toContainEqual(["crm_leads.pipeline_id", PIPE]);
    expect(argDe(chamadas, "order").map((a) => a[0])).toEqual(["lead_id"]);
    expect(argDe(chamadas, "select")[0]?.[1]).toEqual({ count: "exact" });
  });

  it("⭐ (d) fim que não dá para provar AVISA em vez de silêncio", async () => {
    // 5.200 > 5 páginas × 1.000: o laço esgota o teto sem alcançar o `count`.
    const leads = Array.from({ length: 5200 }, (_, i) => negocio(i));
    banco({ crm_pipelines: [funil()], crm_stages: [etapa], crm_leads: leads });

    const { status, corpo, headers } = await lerPrevisao();
    expect(status).toBe(200);

    expect(corpo.data.truncado).toBe(true);
    expect(headers.get("X-Previsao-Truncada")).toBe("1");
    // O que veio é honesto sobre si mesmo: um recorte de 5.000, não a carteira.
    expect(corpo.data.totais[0]?.n).toBe(5000);
  });

  it("(e) negócio de OUTRA organização não entra na soma", async () => {
    banco({
      crm_pipelines: [funil()],
      crm_stages: [etapa],
      crm_leads: [negocio(1), negocio(2), negocio(3, { organization_id: OUTRA_ORG })],
    });

    const { corpo } = await lerPrevisao();
    expect(corpo.data.totais[0]?.n).toBe(2);
  });
});
