/**
 * GET /api/v1/metrics/serie — as guardas da borda (issue #3024, fatia 1).
 *
 * A conta mora em `lib/metrics/serie-temporal.test.ts`; aqui fica o que só a
 * rota pode furar: o piso de papel, a organização que vem do cookie e NUNCA da
 * query, a validação que recusa (422) em vez de adivinhar, o teto de leitura
 * que liga `truncado`, e o fuso da organização chegando à conta.
 *
 * O falso é o mesmo de `funil/route.test.ts`: aplica os filtros no dataset,
 * corta toda resposta em `max_rows = 1000` como o PostgREST e só devolve
 * `count` quando a rota pede `exact`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const JANELA = "from=2026-10-01T03:00:00.000Z&to=2026-10-31T03:00:00.000Z";
const MAX_ROWS = 1000;

type Linha = Record<string, unknown>;

function fakeSupabase(dados: Record<string, Linha[]>) {
  const consultas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  const client = {
    from(tabela: string) {
      const registro = { tabela, filtros: [] as Array<[string, unknown]> };
      consultas.push(registro);
      const filtros: Array<(l: Linha) => boolean> = [];
      let pediuCount = false;
      const base = () => (dados[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));

      const builder: Record<string, unknown> = {};
      builder.select = (_c: string, opcoes?: { count?: string }) => {
        pediuCount = opcoes?.count === "exact";
        return builder;
      };
      builder.eq = (coluna: string, valor: unknown) => {
        registro.filtros.push([coluna, valor]);
        filtros.push((l) => l[coluna] === valor);
        return builder;
      };
      builder.gte = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} >=`, valor]);
        filtros.push((l) => typeof l[coluna] === "string" && String(l[coluna]) >= String(valor));
        return builder;
      };
      builder.lt = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} <`, valor]);
        filtros.push((l) => typeof l[coluna] === "string" && String(l[coluna]) < String(valor));
        return builder;
      };
      builder.order = () => builder;
      builder.range = (inicio: number, fim: number) => {
        const todas = base();
        return Promise.resolve({
          data: todas.slice(inicio, fim + 1).slice(0, MAX_ROWS),
          count: pediuCount ? todas.length : null,
          error: null,
        });
      };
      builder.maybeSingle = () => Promise.resolve({ data: base()[0] ?? null, error: null });
      return builder;
    },
  };
  return { consultas, client };
}

function permitido(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR", organizations: [] } as unknown as AuthUser,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
}

function ganho(id: string, closedAt: string, organizationId = ORG_ID): Linha {
  return { id, organization_id: organizationId, status: "won", closed_at: closedAt };
}

async function chamar(query: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://localhost/api/v1/metrics/serie?${query}`));
}

type Corpo = {
  baldes: Array<{ balde: string; ganhos: number }>;
  total: number;
  truncado: boolean;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/metrics/serie", () => {
  it("recusa (403) quem está abaixo do piso, sem tocar no banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
    } as never);

    const res = await chamar(JANELA);
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("a organização vem do cookie, mesmo com ?organization_id= forjado na query", async () => {
    permitido();
    const { consultas, client } = fakeSupabase({
      organizations: [{ id: ORG_ID, timezone: "UTC" }],
      crm_leads: [
        ganho("meu", "2026-10-10T12:00:00.000Z"),
        ganho("alheio", "2026-10-10T12:00:00.000Z", OUTRA_ORG),
      ],
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${JANELA}&organization_id=${OUTRA_ORG}`);
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Corpo }).data;
    expect(corpo.total).toBe(1);

    const leituras = consultas.filter((c) => c.tabela === "crm_leads");
    expect(leituras.length).toBeGreaterThan(0);
    for (const c of leituras) expect(c.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(consultas.find((c) => c.tabela === "organizations")?.filtros).toEqual([["id", ORG_ID]]);
  });

  it("granularidade fora da lista é recusada (422), nunca tratada como dia", async () => {
    permitido();
    const res = await chamar(`${JANELA}&granularidade=trimestre`);
    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("janela com from >= to é recusada (422)", async () => {
    permitido();
    const res = await chamar("from=2026-10-10T00:00:00.000Z&to=2026-10-10T00:00:00.000Z");
    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("acima do teto de 5 páginas responde truncado: true", async () => {
    permitido();
    const N = 5 * MAX_ROWS + 1;
    const { client } = fakeSupabase({
      organizations: [{ id: ORG_ID, timezone: "UTC" }],
      crm_leads: Array.from({ length: N }, (_, i) => ganho(`g${i}`, "2026-10-10T12:00:00.000Z")),
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(JANELA);
    const corpo = ((await res.json()) as { data: Corpo }).data;
    expect(corpo.truncado).toBe(true);
    expect(corpo.total).toBe(5 * MAX_ROWS);
  });

  it("os baldes viram no fuso da organização: 23h30 de São Paulo fica no dia local", async () => {
    permitido();
    const { client } = fakeSupabase({
      organizations: [{ id: ORG_ID, timezone: "America/Sao_Paulo" }],
      // 2026-10-21 23h30 -03:00.
      crm_leads: [ganho("noite", "2026-10-22T02:30:00.000Z")],
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${JANELA}&granularidade=dia`);
    const corpo = ((await res.json()) as { data: Corpo }).data;
    expect(corpo.baldes.find((b) => b.ganhos === 1)?.balde).toBe("2026-10-21");
  });

  it("fuso que o Intl recusa cai no padrão do produto, sem derrubar a rota", async () => {
    permitido();
    const { client } = fakeSupabase({
      organizations: [{ id: ORG_ID, timezone: "São Paulo" }],
      crm_leads: [ganho("noite", "2026-10-22T02:30:00.000Z")],
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(JANELA);
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Corpo }).data;
    expect(corpo.baldes.find((b) => b.ganhos === 1)?.balde).toBe("2026-10-21");
  });
});
