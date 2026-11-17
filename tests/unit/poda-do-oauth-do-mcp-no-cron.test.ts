/**
 * A poda do OAuth do MCP (migration 9390) roda no cron diário `data-retention`,
 * fora de qualquer requisição pública — e a rodada audita só quando apagou algo. A
 * regra do que é podável mora em `fn_mcp_oauth_podar` e é medida no banco
 * (`tests/invariants/mcp-oauth-servidor.test.ts`); aqui fica o relógio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Cascata from "@/lib/lgpd/cascata";

const h = vi.hoisted(() => ({
  podados: 0 as number,
  erro: null as null | { message: string },
  chamadas: [] as string[],
  auditou: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo", INTERNAL_SECRET: "", JOB_QUEUE_RETENTION_DAYS: "", AUDIT_LOG_RETENTION_DAYS: "" },
}));
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => h.auditou(...args) }));
vi.mock("@/lib/lgpd/cascata", async (original) => ({
  ...(await original<typeof Cascata>()),
  varrerRedacoesIncompletas: async () => ({ examinados: 0, comResiduo: 0, completados: [], temResto: false, falhas: [] }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const vazio: Record<string, unknown> = {
      lt: () => vazio,
      select: () => vazio,
      order: () => vazio,
      limit: () => vazio,
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return {
      rpc: async (nome: string) => {
        h.chamadas.push(nome);
        if (nome === "fn_mcp_oauth_podar") return { data: h.erro ? null : h.podados, error: h.erro };
        if (nome === "fn_enfileirar_midia_vencida") return { data: { vencidas: 0, orfas: 0, expurgadas: 0 }, error: null };
        return { data: 0, error: null };
      },
      from: () => ({ delete: () => vazio }),
    };
  },
}));

const requisicao = () => ({ headers: new Headers({ authorization: "Bearer segredo" }) }) as never;
const acoes = () => h.auditou.mock.calls.map((c) => (c[0] as { action: string }).action);

beforeEach(() => {
  h.podados = 0;
  h.erro = null;
  h.chamadas = [];
  h.auditou.mockClear();
});

describe("cron data-retention: poda do OAuth do MCP", () => {
  it("apagou algo: a rodada audita retention.sweep_run com a contagem e a devolve no corpo", async () => {
    h.podados = 7;
    const { GET } = await import("@/app/api/v1/cron/data-retention/route");
    const resp = await GET(requisicao());
    expect(resp.status).toBe(200);
    expect(h.chamadas).toContain("fn_mcp_oauth_podar");
    expect(acoes()).toEqual(["retention.sweep_run"]);
    expect((h.auditou.mock.calls[0]![0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      oauth_mcp_podados: 7,
    });
    expect(((await resp.json()) as { data: { oauth_mcp_podados: number } }).data.oauth_mcp_podados).toBe(7);
  });

  it("nada a podar: roda e NÃO audita", async () => {
    const { GET } = await import("@/app/api/v1/cron/data-retention/route");
    await GET(requisicao());
    expect(h.chamadas).toContain("fn_mcp_oauth_podar");
    expect(acoes()).toEqual([]);
  });

  it("falha da poda é nomeada em falhas, sem derrubar a rodada em silêncio", async () => {
    h.erro = { message: "function does not exist" };
    const { GET } = await import("@/app/api/v1/cron/data-retention/route");
    const resp = await GET(requisicao());
    expect(resp.status).toBe(500);
    const corpo = (await resp.json()) as { error: { details: { falhas: string[] } } };
    expect(corpo.error.details.falhas.join("|")).toContain("fn_mcp_oauth_podar");
    expect(acoes()).toContain("retention.sweep_run");
  });
});
