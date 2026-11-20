import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TOKEN DE INTEGRAÇÃO TAMBÉM VÊ O FUNIL CORTADO (#5016 com a porta de token da `main`).
 *
 * Pelo token, o mapeamento do funil vem de `lerFunilDoToken` (pipelines e etapas em
 * consultas separadas), não do embed da sessão. O aviso de leitura cortada mede o
 * corte pelo `count` exato; se essa leitura não pede o `count`, só o teto de 1.000
 * linhas denuncia o corte, e um servidor que corta antes (max_rows menor) passa calado.
 * Aqui o servidor devolve 500 etapas de um total de 800: a resposta tem de dizer que
 * o funil veio incompleto, como já diz pela sessão.
 */
const from = vi.fn();
const rpc = vi.fn(async () => ({ data: null, error: { message: "fora do teste" } }));

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: async () => ({
    ok: true,
    via: "token",
    organizationId: "org-1",
    idioma: "pt-BR",
    supabase: { from, rpc },
  }),
  tetoDeEscritaDoToken: async () => null,
}));

const { GET } = await import("@/app/api/v1/ai/evolution/route");

function fakeDb(porTabela: Record<string, unknown[]>, totais: Record<string, number>) {
  from.mockImplementation((tabela: string) => {
    const rows = porTabela[tabela] ?? [];
    let head = false;
    let pediuCount = false;
    const b: Record<string, unknown> = {};
    for (const m of ["not", "limit", "in", "eq", "gte", "lte", "order"]) b[m] = () => b;
    b.select = (_c: string, opts?: { head?: boolean; count?: string }) => {
      head = opts?.head === true;
      pediuCount = opts?.count === "exact";
      return b;
    };
    b.then = (resolve: (v: unknown) => void) =>
      resolve({
        data: head ? null : rows,
        // Como o PostgREST: sem `count` pedido, não vem `count`.
        count: !pediuCount ? null : tabela in totais ? totais[tabela] : rows.length,
        error: null,
      });
    return b;
  });
}

describe("GET /api/v1/ai/evolution pelo token de integração", () => {
  it("500 etapas de 800: crm_stages entra em fontes_incompletas como cortada", async () => {
    const etapas = Array.from({ length: 500 }, (_, i) => ({ agent_stage_hint: `passo-${i}`, pipeline_id: "p1" }));
    fakeDb({ crm_pipelines: [{ id: "p1", name: "Funil A" }], crm_stages: etapas }, { crm_stages: 800 });

    const r = await GET(new NextRequest("http://localhost:3000/api/v1/ai/evolution"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { fontes_incompletas: Array<{ fonte: string; motivo: string }> } };
    expect(body.data.fontes_incompletas).toContainEqual({ fonte: "crm_stages", motivo: "cortada" });
  });

  it("lista de funis cortada (500 de 800): crm_stages entra em fontes_incompletas mesmo com as etapas completas", async () => {
    const funis = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, name: `Funil ${i}` }));
    const etapas = funis.map((f) => ({ agent_stage_hint: "qualificar", pipeline_id: f.id }));
    fakeDb({ crm_pipelines: funis, crm_stages: etapas }, { crm_pipelines: 800 });

    const r = await GET(new NextRequest("http://localhost:3000/api/v1/ai/evolution"));
    const body = (await r.json()) as { data: { fontes_incompletas: Array<{ fonte: string; motivo: string }> } };
    expect(body.data.fontes_incompletas).toContainEqual({ fonte: "crm_stages", motivo: "cortada" });
  });

  it("todas as etapas lidas: o funil não aparece como cortado", async () => {
    const etapas = [{ agent_stage_hint: "qualificar", pipeline_id: "p1" }];
    fakeDb({ crm_pipelines: [{ id: "p1", name: "Funil A" }], crm_stages: etapas }, {});

    const r = await GET(new NextRequest("http://localhost:3000/api/v1/ai/evolution"));
    const body = (await r.json()) as { data: { fontes_incompletas: Array<{ fonte: string; motivo: string }> } };
    expect(body.data.fontes_incompletas).not.toContainEqual({ fonte: "crm_stages", motivo: "cortada" });
  });
});
