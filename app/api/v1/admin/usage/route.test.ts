/**
 * A carteira responde "este cliente está atendendo?" — e a resposta tem de vir
 * do agente PUBLICADO, não da existência de um agente qualquer.
 *
 * ─── O que este arquivo guarda ─────────────────────────────────────────────
 *
 * `agent_name` é o único campo desta rota que não é um número de uso, e o modo
 * de falha dele é silencioso: um agente em rascunho (sem `published_version_id`)
 * ou arquivado apareceria na carteira como se estivesse no ar, e o operador
 * diria ao cliente que está tudo funcionando. Por isso os casos cobrem os três
 * estados — publicado, rascunho e arquivado — e a organização errada.
 *
 * O dublê aplica os filtros de verdade: apagar o `.is("archived_at", null)` ou o
 * `.eq(...)` da organização muda o resultado de algum caso abaixo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET } from "./route";

vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;
type Predicado = (linha: Linha) => boolean;

/** Dublê do client de service role: encadeia, filtra e ORDENA de verdade, e é "thenable". */
function dubleAdmin(
  tabelas: Record<string, Linha[]>,
  falha?: (tabela: string, qtd: number) => boolean,
) {
  const chamadas: Record<string, number> = {};
  function consulta(
    tabela: string,
    predicados: Predicado[] = [],
    ordem?: (a: Linha, b: Linha) => number,
    teto = 1000,
  ) {
    const linhas = () => {
      const filtradas = (tabelas[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
      return (ordem ? [...filtradas].sort(ordem) : filtradas).slice(0, teto);
    };
    const api: Record<string, unknown> = {
      select: () => consulta(tabela, predicados, ordem),
      eq: (coluna: string, valor: unknown) =>
        consulta(tabela, [...predicados, (l) => l[coluna] === valor], ordem),
      is: (coluna: string, valor: unknown) =>
        consulta(tabela, [...predicados, (l) => l[coluna] === valor], ordem),
      not: (coluna: string, op: string, valor: unknown) =>
        consulta(
          tabela,
          [
            ...predicados,
            (l) =>
              op === "in"
                ? !String(valor).slice(1, -1).split(",").includes(String(l[coluna]))
                : l[coluna] !== valor,
          ],
          ordem,
        ),
      in: (coluna: string, valores: unknown[]) =>
        consulta(tabela, [...predicados, (l) => valores.includes(l[coluna])], ordem),
      limit: (n: number) => consulta(tabela, predicados, ordem, Math.min(n, 1000)),
      gt: (coluna: string, valor: string) =>
        consulta(tabela, [...predicados, (l) => String(l[coluna]) > valor], ordem, teto),
      gte: (coluna: string, valor: string) =>
        consulta(tabela, [...predicados, (l) => String(l[coluna]) >= valor], ordem, teto),
      lt: (coluna: string, valor: string) =>
        consulta(tabela, [...predicados, (l) => String(l[coluna]) < valor], ordem, teto),
      // `order` é o que faz o caso "maior prioridade" medir a ROTA e não o
      // dublê: sem ele, o vencedor seria o primeiro do fixture, e a ordem que a
      // rota pede ao banco não estaria sendo exercida.
      order: (coluna: string, opts?: { ascending?: boolean }) =>
        consulta(tabela, predicados, (a, b) => {
          const direcao = opts?.ascending === false ? -1 : 1;
          return (
            direcao *
            (typeof a[coluna] === "number"
              ? Number(a[coluna] ?? 0) - Number(b[coluna] ?? 0)
              : String(a[coluna] ?? "").localeCompare(String(b[coluna] ?? "")))
          );
        }),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Linha[] | null; error: unknown }) => unknown) =>
        resolve(
          falha?.(tabela, (chamadas[tabela] = (chamadas[tabela] ?? 0) + 1))
            ? { data: null, error: { code: "timeout" } }
            : { data: linhas(), error: null },
        ),
    };
    return api;
  }
  return { from: (tabela: string) => consulta(tabela) };
}

function org(id: string, nome: string): Linha {
  return { id, display_name: nome, slug: id.slice(0, 6) };
}

function agentePublicado(over: Linha = {}): Linha {
  return {
    organization_id: ORG_A,
    name: "Agente A",
    priority: 0,
    published_version_id: "88888888-8888-4888-8888-888888888888",
    archived_at: null,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(requirePlatformAdmin).mockReset();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(audit).mockClear();
  vi.mocked(createAdminClient).mockReset();
  vi.mocked(createAdminClient).mockReturnValue(
    dubleAdmin({ organizations: [org(ORG_A, "Cliente A"), org(ORG_B, "Cliente B")] }) as never,
  );
});

function chamar() {
  return GET(new NextRequest("http://localhost/api/v1/admin/usage?range=30d"));
}

describe("GET /api/v1/admin/usage — agente na carteira", () => {
  it("recusa quem não é platform admin", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("nope"));

    const res = await chamar();

    expect(res.status).toBe(403);
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
  });

  it("traz o nome do agente publicado de cada organização", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "Cliente A"), org(ORG_B, "Cliente B")],
        ai_agents: [
          agentePublicado(),
          agentePublicado({ organization_id: ORG_B, name: "Agente B" }),
        ],
      }) as never,
    );

    const corpo = await (await chamar()).json();
    const porOrg = Object.fromEntries(
      corpo.data.tenants.map((t: { organization_id: string; agent_name: string | null }) => [
        t.organization_id,
        t.agent_name,
      ]),
    );

    expect(porOrg[ORG_A]).toBe("Agente A");
    expect(porOrg[ORG_B]).toBe("Agente B");
  });

  it("agente sem publicada não conta como atendendo", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "Cliente A")],
        ai_agents: [agentePublicado({ published_version_id: null })],
      }) as never,
    );

    const corpo = await (await chamar()).json();

    expect(corpo.data.tenants[0].agent_name).toBeNull();
  });

  it("agente arquivado não conta como atendendo", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "Cliente A")],
        ai_agents: [agentePublicado({ archived_at: "2026-08-01T00:00:00.000Z" })],
      }) as never,
    );

    const corpo = await (await chamar()).json();

    expect(corpo.data.tenants[0].agent_name).toBeNull();
  });

  it("com dois publicados, vence o de maior prioridade", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "Cliente A")],
        ai_agents: [
          agentePublicado({ name: "Prioridade baixa", priority: 0 }),
          agentePublicado({ name: "Prioridade alta", priority: 10 }),
        ],
      }) as never,
    );

    const corpo = await (await chamar()).json();

    expect(corpo.data.tenants[0].agent_name).toBe("Prioridade alta");
  });

  it("agente de outra organização não aparece na linha desta", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "Cliente A")],
        ai_agents: [agentePublicado({ organization_id: ORG_B, name: "Do vizinho" })],
      }) as never,
    );

    const corpo = await (await chamar()).json();

    expect(corpo.data.tenants).toHaveLength(1);
    expect(corpo.data.tenants[0].agent_name).toBeNull();
  });
});

describe("uso sem corte em mil registros", () => {
  it("soma tabela e série sobre as mesmas 1501 chamadas", async () => {
    const agora = new Date().toISOString();
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "Cliente A")],
        llm_calls: Array.from({ length: 1501 }, (_, i) => ({
          id: String(i).padStart(6, "0"),
          organization_id: ORG_A,
          created_at: agora,
          input_tokens: 2,
          output_tokens: 3,
          cost_cents: i === 1500 ? null : 1,
        })),
      }) as never,
    );
    const res = await chamar();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.tenants[0].ai_invocations_count).toBe(1501);
    expect(data.tenants[0].ai_tokens_total).toBe(7505);
    expect(data.tenants[0].ai_cost_cents).toBe(1500);
    expect(data.tenants[0].ai_unpriced_count).toBe(1);
    expect(data.series.ai_cost.reduce((n: number, d: { cents: number }) => n + d.cents, 0)).toBe(
      1500,
    );
  });
});

describe("período e falhas da medição", () => {
  it("não devolve total parcial se a segunda página falhar", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin(
        {
          organizations: [org(ORG_A, "A")],
          llm_calls: Array.from({ length: 600 }, (_, i) => ({
            id: String(i).padStart(6, "0"),
            organization_id: ORG_A,
            created_at: new Date().toISOString(),
            cost_cents: 1,
          })),
        },
        (t, n) => t === "llm_calls" && n === 2,
      ) as never,
    );
    const res = await chamar();
    expect(res.status).toBe(500);
    expect((await res.json()).data).toBeUndefined();
  });
  it("usa os mesmos limites UTC na tabela e série", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T15:00:00Z"));
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "A")],
        llm_calls: [
          "2026-10-05T23:59:59Z",
          "2026-10-06T00:00:00Z",
          "2026-11-04T23:59:59Z",
          "2026-11-05T00:00:00Z",
        ].map((created_at, i) => ({
          id: String(i),
          organization_id: ORG_A,
          created_at,
          cost_cents: 1,
        })),
      }) as never,
    );
    const { data } = await (await chamar()).json();
    expect(data.tenants[0].ai_invocations_count).toBe(2);
    expect(data.series.ai_cost).toHaveLength(30);
    expect(data.series.ai_cost[0]).toEqual({ date: "2026-10-06", cents: 1 });
    expect(data.series.ai_cost[29]).toEqual({ date: "2026-11-04", cents: 1 });
  });
  it("preserva filtro de organização em todas as páginas", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      dubleAdmin({
        organizations: [org(ORG_A, "A"), org(ORG_B, "B")],
        llm_calls: Array.from({ length: 1201 }, (_, i) => ({
          id: String(i).padStart(6, "0"),
          organization_id: i % 2 === 0 ? ORG_A : ORG_B,
          created_at: new Date().toISOString(),
          cost_cents: 1,
        })),
      }) as never,
    );
    const { data } = await (
      await GET(new NextRequest(`http://localhost/api/v1/admin/usage?range=30d&tenant_id=${ORG_A}`))
    ).json();
    expect(data.tenants).toHaveLength(1);
    expect(data.tenants[0].ai_invocations_count).toBe(601);
    expect(data.series.ai_cost.reduce((s: number, x: { cents: number }) => s + x.cents, 0)).toBe(
      601,
    );
  });
});

it("mensagens pessoais ficam fora da tabela e da série, inclusive depois da primeira página", async () => {
  const now = new Date().toISOString();
  vi.mocked(createAdminClient).mockReturnValue(
    dubleAdmin({
      organizations: [org(ORG_A, "A")],
      contacts: [{ id: "personal", organization_id: ORG_A, is_personal: true }],
      messages: Array.from({ length: 1502 }, (_, i) => ({
        id: String(i).padStart(6, "0"),
        organization_id: ORG_A,
        created_at: now,
        contact_id: i === 1501 ? "personal" : "commercial",
      })),
      conversations: Array.from({ length: 1501 }, (_, i) => ({
        id: String(i).padStart(6, "0"),
        organization_id: ORG_A,
        created_at: now,
      })),
    }) as never,
  );
  const { data } = await (await chamar()).json();
  expect(data.tenants[0].messages_count).toBe(1501);
  expect(data.tenants[0].conversations_count).toBe(1501);
  expect(data.series.messages.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBe(
    1501,
  );
});
