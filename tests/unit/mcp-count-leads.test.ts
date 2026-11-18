/**
 * crm_count_leads — conta negócios sem listar (nenhum dado pessoal no payload).
 *
 * Motivo: crm_list_leads só pagina por cursor, sem total. Um agente que precisa
 * responder "quantos negócios?" acaba paginando a lista inteira e levando todos
 * ao modelo. Esta tool devolve só números.
 *
 * Prova, contra o handler REAL (ctx.supabase stub):
 *  - toda contagem filtra organization_id (o client do MCP é service-role);
 *  - sem filtro de status: total + by_status{open,won,lost}; com status: só o total;
 *  - filtros de funil/etapa são repassados;
 *  - contato pessoal fica de fora (mesma régua da listagem);
 *  - em conversa de atendimento, conta só o contato do turno;
 *  - o payload não tem negócio, nome nem id;
 *  - erro do banco propaga (nunca devolve 0 silencioso).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));

import { crmCountLeads } from "@/lib/mcp/tools/leads";
import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const PIPE = "44444444-4444-4444-8444-444444444444";
const STAGE = "55555555-5555-4555-8555-555555555551";
const PESSOAL = "99999999-9999-4999-8999-999999999999";
const CONTATO_TURNO = "88888888-8888-4888-8888-888888888888";

interface Call {
  table: string;
  opts: Record<string, unknown> | undefined;
  eqs: Record<string, unknown>;
  nots: Array<[string, string, string]>;
}

type Counts = { all?: number; open?: number; won?: number; lost?: number };

function makeCtx(
  counts: Counts,
  opts: { error?: string; pessoais?: string[]; contatoDoTurno?: string } = {},
): { ctx: McpContext; calls: Call[] } {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, opts: undefined, eqs: {}, nots: [] };
    calls.push(call);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (_cols: string, o?: Record<string, unknown>) => {
        call.opts = o;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        call.eqs[col] = val;
        return chain;
      },
      not: (col: string, op: string, val: string) => {
        call.nots.push([col, op, val]);
        return chain;
      },
      limit: () => chain,
      then: (res: (v: unknown) => unknown) => {
        if (table === "contacts") {
          return Promise.resolve({
            data: (opts.pessoais ?? []).map((id) => ({ id })),
            error: null,
          }).then(res);
        }
        if (opts.error) {
          return Promise.resolve({ count: null, error: { message: opts.error } }).then(res);
        }
        const status = call.eqs.status as keyof Counts | undefined;
        return Promise.resolve({ count: counts[status ?? "all"] ?? 0, error: null }).then(res);
      },
    };
    return chain;
  };
  const ctx = {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "run_1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req",
    contatoDoTurno: opts.contatoDoTurno,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from } as any,
  } as McpContext;
  return { ctx, calls };
}

const soLeads = (calls: Call[]) => calls.filter((c) => c.table === "crm_leads");

describe("crm_count_leads", () => {
  it("sem filtro de status devolve total e by_status, sempre com organization_id", async () => {
    const { ctx, calls } = makeCtx({ all: 1391, open: 1300, won: 3, lost: 88 });
    const out = await crmCountLeads.handler({}, ctx);
    expect(out).toEqual({ total: 1391, by_status: { open: 1300, won: 3, lost: 88 } });
    const leads = soLeads(calls);
    expect(leads).toHaveLength(4);
    for (const c of leads) {
      expect(c.eqs.organization_id).toBe(ORG);
      // head + count exato: não traz nenhuma linha
      expect(c.opts).toEqual({ count: "exact", head: true });
    }
  });

  it("com status devolve só o total e uma contagem", async () => {
    const { ctx, calls } = makeCtx({ won: 3 });
    const out = await crmCountLeads.handler({ status: "won" }, ctx);
    expect(out).toEqual({ total: 3 });
    const leads = soLeads(calls);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.eqs).toMatchObject({ organization_id: ORG, status: "won" });
  });

  it("repassa funil e etapa", async () => {
    const { ctx, calls } = makeCtx({ all: 7, open: 7 });
    await crmCountLeads.handler({ pipeline_id: PIPE, stage_id: STAGE }, ctx);
    for (const c of soLeads(calls)) {
      expect(c.eqs).toMatchObject({
        organization_id: ORG,
        pipeline_id: PIPE,
        stage_id: STAGE,
      });
    }
  });

  it("contato pessoal fica de fora, como na listagem", async () => {
    const { ctx, calls } = makeCtx({ all: 5, open: 5 }, { pessoais: [PESSOAL] });
    await crmCountLeads.handler({}, ctx);
    for (const c of soLeads(calls)) {
      expect(c.nots).toEqual([["contact_id", "in", `(${PESSOAL})`]]);
    }
    // e a busca dos pessoais também é da organização certa
    const contatos = calls.find((c) => c.table === "contacts");
    expect(contatos?.eqs).toMatchObject({ organization_id: ORG, is_personal: true });
  });

  it("em conversa de atendimento conta só o contato do turno", async () => {
    const { ctx, calls } = makeCtx({ all: 1, open: 1 }, { contatoDoTurno: CONTATO_TURNO });
    await crmCountLeads.handler({}, ctx);
    for (const c of soLeads(calls)) {
      expect(c.eqs.contact_id).toBe(CONTATO_TURNO);
    }
  });

  it("não expõe negócios nem dados pessoais", async () => {
    const { ctx } = makeCtx({ all: 5, open: 5 });
    const out = (await crmCountLeads.handler({}, ctx)) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["by_status", "total"]);
    expect(JSON.stringify(out)).not.toMatch(/name|phone|email|uuid|[0-9a-f]{8}-/i);
  });

  it("erro do banco propaga em vez de devolver 0", async () => {
    const { ctx } = makeCtx({}, { error: "boom" });
    await expect(crmCountLeads.handler({}, ctx)).rejects.toThrow("boom");
  });

  it("é leitura, role agent, scope mcp:read, e está no índice e no catálogo", () => {
    expect(crmCountLeads.category).toBe("read");
    expect(crmCountLeads.requiresRole).toBe("agent");
    expect(crmCountLeads.requiresScope).toBe("mcp:read");
    expect(allTools.map((t) => t.name)).toContain("crm_count_leads");
    expect(TOOL_CATALOG.map((t) => t.name)).toContain("crm_count_leads");
  });
});
