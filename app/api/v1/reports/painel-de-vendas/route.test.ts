/**
 * GET /api/v1/reports/painel-de-vendas — a rota (a conta é provada em
 * `lib/relatorios/painel-de-vendas.test.ts`).
 *
 *  1. a consulta é UMA, filtrada pela organização do cookie, com ganhos E
 *     perdidos e a janela semiaberta no fuso da organização;
 *  2. a resposta traz os cartões e a série;
 *  3. sem parâmetro, o período é o mês corrente (o mesmo padrão do Faturamento);
 *  4. data inválida, invertida ou além do teto é 422, sem consulta ao banco;
 *  5. falha de leitura SOBE (500), nunca vira "não houve venda";
 *  6. sem papel, a rota responde o que `requireRole` devolveu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

const ORG = "11111111-1111-1111-1111-111111111111";

function makeDb(linhas: Record<string, unknown>[], erro: string | null = null) {
  const ops: string[] = [];
  let faixa: [number, number] | null = null;
  const b: Record<string, unknown> = {
    select: () => b,
    eq(c: string, v: unknown) {
      ops.push(`eq:${c}=${String(v)}`);
      return b;
    },
    in(c: string, v: unknown[]) {
      ops.push(`in:${c}=${v.join(",")}`);
      return b;
    },
    gte(c: string, v: unknown) {
      ops.push(`gte:${c}=${String(v)}`);
      return b;
    },
    lt(c: string, v: unknown) {
      ops.push(`lt:${c}=${String(v)}`);
      return b;
    },
    order: () => b,
    range(i: number, f: number) {
      faixa = [i, f];
      return b;
    },
    then(ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) {
      const resposta = erro
        ? { data: null, error: { message: erro }, count: null }
        : { data: faixa ? linhas.slice(faixa[0], faixa[1] + 1) : linhas, error: null, count: linhas.length };
      return Promise.resolve(resposta).then(ok, falha);
    },
  };
  const db = { from: vi.fn(() => b) };
  vi.mocked(createClient).mockResolvedValue(db as never);
  return { db, ops };
}

function authOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR", is_platform_admin: false, support: false },
    org: { orgId: ORG, name: "Empresa", role: "viewer", timezone: "America/Sao_Paulo", currency: "BRL" },
  } as never);
}

function pedir(query = "?de=2026-11-01&ate=2026-11-19") {
  return new NextRequest(`http://localhost/api/v1/reports/painel-de-vendas${query}`);
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/reports/painel-de-vendas", () => {
  it("lê ganhos e perdidos da organização na janela do fuso, e devolve cartões e série", async () => {
    authOk();
    const { db, ops } = makeDb([
      { status: "won", closed_at: "2026-11-03T15:00:00.000Z", value_cents: 30_000, currency: "BRL" },
      { status: "won", closed_at: "2026-11-05T15:00:00.000Z", value_cents: 10_000, currency: "BRL" },
      { status: "lost", closed_at: "2026-11-06T15:00:00.000Z", value_cents: 9_000, currency: "BRL" },
    ]);

    const res = await GET(pedir());
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.from).toHaveBeenCalledWith("crm_leads");
    expect(ops).toContain(`eq:organization_id=${ORG}`);
    expect(ops).toContain("in:status=won,lost");
    // 01/11 00h em São Paulo = 03h UTC; o fim é 00h de 20/11, aberto.
    expect(ops).toContain("gte:closed_at=2026-11-01T03:00:00.000Z");
    expect(ops).toContain("lt:closed_at=2026-11-20T03:00:00.000Z");

    expect(corpo.data).toMatchObject({
      vendas: 2,
      vendido_centavos: 40_000,
      ticket_medio_centavos: 20_000,
      perdidos: 1,
      moeda: "BRL",
      granularidade: "dia",
      truncado: false,
    });
    expect(corpo.data.conversao).toBeCloseTo(2 / 3);
    expect((corpo.data.serie as unknown[]).length).toBe(19);
  });

  it("sem parâmetro, o período é o mês corrente da organização", async () => {
    authOk();
    makeDb([]);

    const res = await GET(pedir(""));
    const corpo = (await res.json()) as { data: { janela: { de: string; ate: string } } };

    expect(res.status).toBe(200);
    expect(corpo.data.janela.de).toMatch(/^\d{4}-\d{2}-01$/);
    expect(corpo.data.janela.de.slice(0, 7)).toBe(corpo.data.janela.ate.slice(0, 7));
  });

  it.each([
    ["data inválida", "?de=2026-99-99&ate=2026-11-19"],
    ["período invertido", "?de=2026-11-19&ate=2026-11-01"],
    ["além do teto", "?de=2020-01-01&ate=2026-11-19"],
  ])("%s: 422, e o banco nem é consultado", async (_caso, query) => {
    authOk();
    const { db } = makeDb([]);

    const res = await GET(pedir(query));

    expect(res.status).toBe(422);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("falha de leitura sobe como 500 — nunca vira 'não houve venda'", async () => {
    authOk();
    makeDb([], "connection reset");

    const res = await GET(pedir());

    expect(res.status).toBe(500);
  });

  it("sem papel, devolve a resposta do portão", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    } as never);
    const { db } = makeDb([]);

    const res = await GET(pedir());

    expect(res.status).toBe(403);
    expect(db.from).not.toHaveBeenCalled();
  });
});
