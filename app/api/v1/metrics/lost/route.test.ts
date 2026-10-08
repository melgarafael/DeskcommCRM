/**
 * GET /api/v1/metrics/lost — a rota do relatório "Perdas" (issues #1537, #2548).
 *
 * Sem banco: a rota é medida no que É DELA — janela, escopo manager+ e,
 * sobretudo, a leitura PAGINADA contra o teto do PostgREST. `max_rows = 1000`
 * (`supabase/config.toml`) corta um `.limit(5000)` em 1000 linhas caladas, o
 * total saía errado e o `truncado` nunca ligava. O falso abaixo impõe esse
 * teto em TODA resposta. A régua da CONTA mora em `lib/metrics/perdas.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { MOTIVO_DA_TRANSFERENCIA } from "@/lib/leads/motivo-da-perda";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const JANELA = "?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";
const URL = `http://localhost/api/v1/metrics/lost${JANELA}`;

/** `max_rows = 1000` do PostgREST: o corte é do SERVIDOR, não do `.limit()`. */
const MAX_ROWS = 1000;
/** O teto declarado na rota: 5 páginas de 1000 = 5000. */
const PAGINAS_MAXIMAS = 5;

function usuario(): AuthUser {
  return {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as AuthUser;
}

type Linha = Record<string, unknown>;

/**
 * O mesmo falso do funil: dataset por tabela, filtros aplicados nele e TODA
 * resposta cortada em `MAX_ROWS`. `count` só vem quando a rota pede `exact`.
 */
function fakeSupabase(dados: Record<string, Linha[]>, erroEm?: string) {
  const consultas: Array<{
    tabela: string;
    filtros: Array<[string, unknown]>;
    ordens: string[];
    faixas: Array<[number, number]>;
    contou: boolean;
  }> = [];

  const client = {
    from(tabela: string) {
      const registro = {
        tabela,
        filtros: [] as Array<[string, unknown]>,
        ordens: [] as string[],
        faixas: [] as Array<[number, number]>,
        contou: false,
      };
      consultas.push(registro);

      const filtros: Array<(linha: Linha) => boolean> = [];
      let pediuCount = false;

      const executar = (faixa: [number, number] | null) => {
        if (erroEm === tabela) {
          return { data: null, count: null, error: { message: "falhou" } } as const;
        }
        const base = (dados[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        const fatia = faixa ? base.slice(faixa[0], faixa[1] + 1) : base;
        return {
          data: fatia.slice(0, MAX_ROWS),
          count: pediuCount ? base.length : null,
          error: null,
        } as const;
      };

      const builder: Record<string, unknown> = {};
      builder.select = (_colunas: string, opcoes?: { count?: string }) => {
        pediuCount = opcoes?.count === "exact";
        registro.contou = pediuCount;
        return builder;
      };
      builder.eq = (coluna: string, valor: unknown) => {
        registro.filtros.push([coluna, valor]);
        filtros.push((l) => !(coluna in l) || l[coluna] === valor);
        return builder;
      };
      builder.gte = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} >=`, valor]);
        filtros.push(
          (l) =>
            l[coluna] !== null && l[coluna] !== undefined && String(l[coluna]) >= String(valor),
        );
        return builder;
      };
      builder.lt = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} <`, valor]);
        filtros.push(
          (l) => l[coluna] !== null && l[coluna] !== undefined && String(l[coluna]) < String(valor),
        );
        return builder;
      };
      builder.order = (coluna: string) => {
        registro.ordens.push(coluna);
        return builder;
      };
      builder.range = (inicio: number, fim: number) => {
        registro.faixas.push([inicio, fim]);
        return Promise.resolve(executar([inicio, fim]));
      };
      // O caminho de quem NÃO paginou (e o da sabotagem): também cortado em 1000.
      builder.limit = (n: number) => {
        const resposta = executar(null);
        return Promise.resolve({
          ...resposta,
          data: (resposta.data ?? []).slice(0, Math.min(n, MAX_ROWS)),
        });
      };
      builder.then = (
        ok?: (v: ReturnType<typeof executar>) => unknown,
        erro?: (e: unknown) => unknown,
      ): Promise<unknown> => Promise.resolve(executar(null)).then(ok, erro);
      return builder;
    },
  };
  return { consultas, client };
}

const FUNIS: Linha[] = [{ id: "f1", settings: { lost_reasons: ["price"] } }];
const ETAPAS: Linha[] = [{ id: "S1", name: "Proposta" }];

function perda(i: number, parcial: Linha = {}): Linha {
  return {
    id: `p${String(i).padStart(4, "0")}`,
    organization_id: ORG_ID,
    status: "lost",
    lost_reason: "price",
    lost_from_stage_id: "S1",
    value_cents: 100,
    currency: "BRL",
    pipeline_id: "f1",
    closed_at: "2026-09-15T12:00:00.000Z",
    ...parcial,
  };
}

function dado(): { crm_leads: Linha[]; crm_pipelines: Linha[]; crm_stages: Linha[] } {
  return { crm_leads: [], crm_pipelines: FUNIS, crm_stages: ETAPAS };
}

async function chamar(url = URL): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest(url));
}

function permitido(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(),
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
}

function corpo(res: Response): Promise<Record<string, unknown>> {
  return res.json().then((r) => (r as { data: Record<string, unknown> }).data);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/metrics/lost", () => {
  it("lê 1.200 perdas inteiras apesar do teto de 1.000 do PostgREST (issue #2548)", async () => {
    permitido();
    const N = 1200;
    const dados = dado();
    dados.crm_leads = Array.from({ length: N }, (_, i) => perda(i));
    const { consultas, client } = fakeSupabase(dados);
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const data = await corpo(res);

    // Com `.limit(LIMITE)` isto seria 1000: o servidor corta em max_rows.
    expect(data.total).toBe(N);
    expect(data.truncado).toBe(false);
    expect(data.porMoeda).toEqual([{ moeda: "BRL", quantidade: N, valor_cents: N * 100 }]);

    const paginas = consultas.filter((c) => c.tabela === "crm_leads");
    expect(paginas.map((c) => c.faixas[0])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    // Ordem estável: sobra o período mais RECENTE se o teto cortar.
    expect(paginas.map((c) => c.ordens)).toEqual([
      ["closed_at", "id"],
      ["closed_at", "id"],
    ]);
    // `count` exato SÓ na primeira página — é ele que prova o fim.
    expect(paginas.map((c) => c.contou)).toEqual([true, false]);
    expect(paginas[0]?.filtros).toEqual([
      ["organization_id", ORG_ID],
      ["status", "lost"],
      ["closed_at >=", "2026-09-01T00:00:00.000Z"],
      ["closed_at <", "2026-10-01T00:00:00.000Z"],
    ]);
    // Os apoios continuam numa leitura só.
    expect(consultas.filter((c) => c.tabela !== "crm_leads")).toHaveLength(2);
  });

  it("acima do teto de 5.000 linhas responde truncado: true", async () => {
    permitido();
    const N = PAGINAS_MAXIMAS * 1000 + 1;
    const dados = dado();
    dados.crm_leads = Array.from({ length: N }, (_, i) => perda(i));
    const { consultas, client } = fakeSupabase(dados);
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const data = await corpo(res);

    expect(data.total).toBe(PAGINAS_MAXIMAS * 1000);
    expect(data.truncado).toBe(true);
    const paginas = consultas.filter((c) => c.tabela === "crm_leads");
    expect(paginas.map((c) => c.faixas[0])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3999],
      [4000, 4999],
    ]);
  });

  it("conta só a janela e não conta transferência entre funis como perda", async () => {
    permitido();
    const dados = dado();
    dados.crm_leads = [
      perda(1, { closed_at: "2026-08-15T12:00:00.000Z" }), // fora: antes de from
      perda(2, { closed_at: "2026-10-15T12:00:00.000Z" }), // fora: depois de to
      perda(3, { status: "open" }), // fora: não é perda
      perda(4, { lost_reason: MOTIVO_DA_TRANSFERENCIA }), // segue vivo no destino
      perda(5), // a única
    ];
    const { client } = fakeSupabase(dados);
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const data = await corpo(res);
    expect(data.total).toBe(1);
    expect(data.truncado).toBe(false);
    expect(data.porMotivo as Array<{ chave: string; quantidade: number }>).toEqual([
      { chave: "price", quantidade: 1 },
    ]);
  });

  it("erro de leitura vira 500", async () => {
    permitido();
    const { client } = fakeSupabase(dado(), "crm_leads");
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(500);
    const erro = (await res.json()) as { error: { message: string } };
    expect(erro.error.message).toContain("falhou");
  });

  it("leitura recusada para quem não é manager não toca no banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
    } as never);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest(URL));
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("janela invertida (from >= to) responde 422 sem tocar no banco", async () => {
    permitido();
    const { consultas, client } = fakeSupabase(dado());
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const res = await chamar(
      "http://localhost/api/v1/metrics/lost?from=2026-10-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
    );
    expect(res.status).toBe(422);
    expect(consultas).toHaveLength(0);
  });
});
