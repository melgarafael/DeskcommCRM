/**
 * GET /api/v1/metrics/metas — a meta mensal e o progresso (issue #3025, fatia 1).
 *
 * Dados fixados, sem banco: a rota devolve o alvo da empresa no MÊS da janela
 * pedida, o REALIZADO contado naquela janela (status `won` e `closed_at` entre
 * `from` e `to`) e o derivado — percentual, quanto falta e se foi atingida.
 * Caso sem meta responde vazio explicando: nunca NaN, nunca 0 fingindo medição.
 *
 * O falso NÃO é ingênuo: ele APLICA os filtros no dataset de cada tabela
 * (`.eq`/`.gte`/`.lt`), respeita `head: true` (que é como a contagem por
 * `count: "exact"` chega sem trazer linha) e o `select` da tabela-base sem
 * contagem. É por isso que ele também mede a JANELA: um ganho fechado fora dela
 * só deixa de contar se a rota de fato filtrar `closed_at` — a sabotagem que
 * remove esse filtro tem de derrubar estes casos, e derruba.
 *
 * A organização vem do `requireRole` (cookie validado); o falso filtra por
 * `organization_id`, então uma meta cadastrada na org do vizinho NÃO aparece —
 * é o mesmo eixo que o invariante de RLS mede em banco de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ORG_VIZINHA = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
/** Setembro de 2026: a janela que a meta da fixture refere. */
const DE = "2026-09-01T00:00:00.000Z";
const ATE = "2026-10-01T00:00:00.000Z";
const URL = `http://localhost/api/v1/metrics/metas?from=${DE}&to=${ATE}`;
const PERIODO = "2026-09-01";

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
type Resposta = { data: unknown; count: number | null; error: { message: string } | null };

/**
 * Query builder mínimo com a régua do SERVIDOR.
 *
 * `select(colunas, { count, head })`: `head: true` devolve `data: null` e só o
 * `count`, exatamente como o PostgREST — é o caminho da contagem do realizado.
 */
function fakeSupabase(dados: Record<string, Linha[]>, erroEm?: string) {
  const consultas: Array<{ tabela: string; filtros: Array<[string, unknown]>; contou: boolean }> =
    [];

  const client = {
    from(tabela: string) {
      const registro = { tabela, filtros: [] as Array<[string, unknown]>, contou: false };
      consultas.push(registro);

      const filtros: Array<(linha: Linha) => boolean> = [];
      let pediuCount = false;
      let pediuHead = false;

      const executar = (): Resposta => {
        if (erroEm === tabela) return { data: null, count: null, error: { message: "falhou" } };
        const base = (dados[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        return {
          data: pediuHead ? null : base,
          count: pediuCount ? base.length : null,
          error: null,
        };
      };

      const builder: Record<string, unknown> = {};
      builder.select = (_colunas: string, opcoes?: { count?: string; head?: boolean }) => {
        pediuCount = opcoes?.count === "exact";
        pediuHead = opcoes?.head === true;
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
          (l) => l[coluna] !== null && l[coluna] !== undefined && String(l[coluna]) >= String(valor),
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
      builder.then = (
        ok?: (v: Resposta) => unknown,
        erro?: (e: unknown) => unknown,
      ): Promise<unknown> => Promise.resolve(executar()).then(ok, erro);
      return builder;
    },
  };
  return { consultas, client };
}

function meta(id: string, parcial: Record<string, unknown>): Linha {
  return {
    id,
    organization_id: ORG_ID,
    indicador: "vendas_ganhas",
    periodo: PERIODO,
    pipeline_id: null,
    alvo: 10,
    ...parcial,
  };
}

/**
 * Um negócio ganho: `status` e `closed_at` são o par que define o realizado.
 * `pipeline_id` nulo = o funil não recorta (a meta da empresa conta tudo).
 */
function lead(id: string, parcial: Record<string, unknown>): Linha {
  return {
    id,
    organization_id: ORG_ID,
    status: "won",
    pipeline_id: null,
    closed_at: "2026-09-10T12:00:00.000Z",
    ...parcial,
  };
}

/**
 * Fixture feliz: alvo 10, TRÊS ganhos fechados na janela — e três armadilhas
 * que só contam se a rota estiver errada: um ganho fechado em AGOSTO (fora da
 * janela), um perdido DENTRO da janela e um ganho sem `closed_at`.
 */
function setembro(): Record<string, Linha[]> {
  return {
    crm_metas: [meta("m1", { alvo: 10 })],
    crm_leads: [
      lead("g1", {}),
      lead("g2", { closed_at: "2026-09-20T12:00:00.000Z" }),
      lead("g3", { closed_at: "2026-09-30T23:00:00.000Z" }),
      lead("g4", { closed_at: "2026-08-31T23:00:00.000Z" }),
      lead("p1", { status: "lost" }),
      lead("o1", { status: "open", closed_at: null }),
      // O vizinho: a MESMA meta, na outra organização. Não pode aparecer.
      meta("m2", { organization_id: ORG_VIZINHA, alvo: 999 }),
      lead("v1", { organization_id: ORG_VIZINHA }),
    ],
    crm_pipelines: [{ id: "f1", name: "Comercial", organization_id: ORG_ID }],
  };
}

type MetaNaResposta = {
  escopo: string;
  pipeline_id: string | null;
  alvo: number;
  realizado: number;
  percentual: number;
  falta: number;
  atingida: boolean;
};

async function chamar(url = URL): Promise<{ status: number; data: Record<string, unknown> }> {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(url));
  return { status: res.status, data: ((await res.json()) as { data: Record<string, unknown> }).data };
}

function permitido(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(),
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/metrics/metas", () => {
  it("com meta: devolve alvo, realizado da janela, percentual e quanto falta", async () => {
    permitido();
    const { consultas, client } = fakeSupabase(setembro());
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { status, data } = await chamar();
    expect(status).toBe(200);
    expect(data.periodo).toBe(PERIODO);
    expect(data.motivo).toBeNull();

    const metas = data.metas as MetaNaResposta[];
    expect(metas).toHaveLength(1);
    const m = metas[0]!;
    expect(m.escopo).toBe("empresa");
    expect(m.pipeline_id).toBeNull();
    expect(m.alvo).toBe(10);
    // Três ganhos na janela: o de agosto, o perdido e o sem `closed_at` NÃO entram.
    expect(m.realizado).toBe(3);
    expect(m.percentual).toBe(30);
    expect(m.falta).toBe(7);
    expect(m.atingida).toBe(false);

    // A contagem foi pedida como `head` + `count exact` — não é um `.limit()`.
    const contagem = consultas.find((c) => c.tabela === "crm_leads")!;
    expect(contagem.contou).toBe(true);
    expect(contagem.filtros).toContainEqual(["status", "won"]);
    expect(contagem.filtros).toContainEqual(["closed_at >=", DE]);
    expect(contagem.filtros).toContainEqual(["closed_at <", ATE]);
  });

  it("a janela é o recorte: ganho fechado FORA dela não entra no realizado", async () => {
    permitido();
    const dados = setembro();
    // Só o ganho de AGOSTO, fora da janela: o realizado tem de ser zero.
    dados.crm_leads = [lead("g4", { closed_at: "2026-08-31T23:00:00.000Z" })];
    const { client } = fakeSupabase(dados);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { data } = await chamar();
    const m = (data.metas as MetaNaResposta[])[0]!;
    expect(m.realizado).toBe(0);
    expect(m.percentual).toBe(0);
    expect(m.falta).toBe(10);
  });

  it("meta do vizinho não aparece: o escopo é a organização da sessão", async () => {
    permitido();
    const { client } = fakeSupabase(setembro());
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { data } = await chamar();
    const metas = data.metas as MetaNaResposta[];
    expect(metas).toHaveLength(1);
    expect(metas[0]!.alvo).toBe(10);
    expect(metas.some((m) => m.alvo === 999)).toBe(false);
    // E o ganho do vizinho também não foi contado.
    expect(metas[0]!.realizado).toBe(3);
  });

  it("meta atingida: percentual passa de 100 e o que falta zera (nunca negativo)", async () => {
    permitido();
    const dados = setembro();
    dados.crm_metas = [meta("m1", { alvo: 2 })];
    const { client } = fakeSupabase(dados);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { data } = await chamar();
    const m = (data.metas as MetaNaResposta[])[0]!;
    expect(m.alvo).toBe(2);
    expect(m.realizado).toBe(3);
    expect(m.percentual).toBe(150);
    expect(m.falta).toBe(0);
    expect(m.atingida).toBe(true);
  });

  it("sem meta: responde vazio EXPLICANDO, e nenhum número vira NaN", async () => {
    permitido();
    const dados = setembro();
    dados.crm_metas = [];
    const { client } = fakeSupabase(dados);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { status, data } = await chamar();
    expect(status).toBe(200);
    expect(data.metas).toEqual([]);
    expect(data.motivo).toBe("sem_meta");
    expect(typeof data.explicacao).toBe("string");
    expect((data.explicacao as string).length).toBeGreaterThan(20);
    // A prova de que não há medição fingida: nenhum campo numérico de meta.
    expect(JSON.stringify(data)).not.toContain("NaN");
    expect(JSON.stringify(data)).not.toContain("null,\"alvo\"");
  });

  it("meta de outro indicador/período não é lida como se fosse deste mês", async () => {
    permitido();
    const dados = setembro();
    dados.crm_metas = [
      meta("m1", { periodo: "2026-08-01" }),
      meta("m2", { indicador: "valor_vendido" }),
    ];
    const { client } = fakeSupabase(dados);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { data } = await chamar();
    expect(data.metas).toEqual([]);
    expect(data.motivo).toBe("sem_meta");
  });

  it("leitura falhando na tabela de metas devolve 500, não um zero silencioso", async () => {
    permitido();
    const { client } = fakeSupabase(setembro(), "crm_metas");
    vi.mocked(createClient).mockResolvedValue(client as never);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest(URL));
    expect(res.status).toBe(500);
    const corpo = (await res.json()) as { error?: { code?: string } };
    expect(corpo.error?.code).toBe("internal_error");
  });

  it("janela inválida (from >= to) é recusada antes de qualquer leitura", async () => {
    permitido();
    const { consultas, client } = fakeSupabase(setembro());
    vi.mocked(createClient).mockResolvedValue(client as never);

    const url = `http://localhost/api/v1/metrics/metas?from=${ATE}&to=${DE}`;
    const { GET } = await import("./route");
    const res = await GET(new NextRequest(url));
    expect(res.status).toBe(422);
    expect(consultas).toHaveLength(0);
  });
});
