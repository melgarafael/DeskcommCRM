import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";

/**
 * A tela Execuções de IA dizia "0 execuções" com 548 linhas no banco: lia
 * `llm_calls` com o client de SESSÃO, que na VPS não enxerga essa tabela. Aqui o
 * client de sessão devolve vazio (como na VPS) e o de serviço devolve a linha —
 * a rota tem de mostrar a linha, filtrada pela organização ativa.
 */
const { LINHA, filtros } = vi.hoisted(() => ({
  LINHA: {
    id: "call-1",
    purpose: "agent_turn",
    provider: "openai",
    model: "gpt-5.6-terra",
    status: "ok",
    error_code: null,
    error_message: null,
    http_status: null,
    origem_da_escolha: null,
    input_tokens: 10,
    output_tokens: 5,
    cost_cents: 1,
    latency_ms: 100,
    created_at: "2026-10-02T18:43:33Z",
  },
  filtros: [] as Array<[string, unknown]>,
}));

function cadeia(linhas: unknown[]) {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = (coluna: string, valor: unknown) => {
    filtros.push([coluna, valor]);
    return c;
  };
  c.order = () => c;
  c.limit = () => c;
  c.or = () => c;
  c.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(ok, erro);
  return c;
}

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: () => cadeia([]) })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: () => cadeia([LINHA]) })),
}));

const { GET } = await import("@/app/api/v1/ai/runs/route");

beforeEach(() => {
  filtros.length = 0;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { idioma: "pt-BR" } as never,
    org: { orgId: "org-escale", name: "Escale IA", role: "admin" } as never,
  });
});

describe("GET /api/v1/ai/runs", () => {
  it("mostra as execuções lidas pelo servidor, filtradas pela organização ativa", async () => {
    const res = await GET(new NextRequest("http://localhost/api/v1/ai/runs"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { execucoes: Array<{ id: string }> } };
    expect(corpo.data.execucoes.map((e) => e.id)).toEqual(["call-1"]);
    expect(filtros).toContainEqual(["organization_id", "org-escale"]);
  });
});
