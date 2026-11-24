/**
 * crm_count_conversations — conta conversas sem listar (nenhuma prévia, nenhum dado pessoal).
 *
 * Motivo (#4996, item 2): a única forma de o agente saber "quantas conversas
 * abertas?" era paginar crm_list_conversations (50 em 50, com prévia da última
 * mensagem de cada uma). Esta tool devolve só números.
 *
 * Prova, contra o handler REAL (ctx.supabase stub):
 *  - toda contagem filtra organization_id (o client do MCP é service-role);
 *  - sem filtro de status: total + by_status dos seis status; com status: só o total;
 *  - contato pessoal fica de fora (mesma régua da listagem);
 *  - canal desativado (quarentena) fica de fora;
 *  - em conversa de atendimento, conta só o contato do turno;
 *  - isolamento entre organizações: nenhuma consulta sem organization_id;
 *  - o payload só tem números;
 *  - erro do banco propaga (nunca devolve 0 silencioso).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));

import { crmCountConversations } from "@/lib/mcp/tools/conversations";
import { allTools } from "@/lib/mcp/tools";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "22222222-2222-4222-8222-222222222222";
const PESSOAL = "99999999-9999-4999-8999-999999999999";
const CANAL_OFF = "77777777-7777-4777-8777-777777777777";
const CONTATO_TURNO = "88888888-8888-4888-8888-888888888888";

interface Call {
  table: string;
  opts: Record<string, unknown> | undefined;
  eqs: Record<string, unknown>;
  nots: Array<[string, string, string]>;
}

type Counts = Partial<
  Record<"all" | "open" | "pending" | "claimed" | "ai_handling" | "closed" | "archived", number>
>;

function makeCtx(
  counts: Counts,
  opts: {
    error?: string;
    pessoais?: string[];
    desativados?: string[];
    contatoDoTurno?: string;
  } = {},
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
      filter: () => chain,
      limit: () => chain,
      then: (res: (v: unknown) => unknown) => {
        if (table === "contacts") {
          return Promise.resolve({
            data: (opts.pessoais ?? []).map((id) => ({ id })),
            error: null,
          }).then(res);
        }
        if (table === "channel_sessions") {
          return Promise.resolve({
            data: (opts.desativados ?? []).map((id) => ({ id })),
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

const soConversas = (calls: Call[]) => calls.filter((c) => c.table === "conversations");

describe("crm_count_conversations", () => {
  it("sem filtro de status devolve total e by_status, sempre com organization_id", async () => {
    const { ctx, calls } = makeCtx({
      all: 40,
      open: 10,
      pending: 5,
      claimed: 8,
      ai_handling: 12,
      closed: 4,
      archived: 1,
    });
    const out = await crmCountConversations.handler({}, ctx);
    expect(out).toEqual({
      total: 40,
      by_status: { open: 10, pending: 5, claimed: 8, ai_handling: 12, closed: 4, archived: 1 },
    });
    const conversas = soConversas(calls);
    expect(conversas).toHaveLength(7);
    for (const c of conversas) {
      expect(c.eqs.organization_id).toBe(ORG);
      // head + count exato: não traz nenhuma linha (nem prévia de mensagem)
      expect(c.opts).toEqual({ count: "exact", head: true });
    }
  });

  it("com status devolve só o total e uma contagem", async () => {
    const { ctx, calls } = makeCtx({ pending: 5 });
    const out = await crmCountConversations.handler({ status: "pending" }, ctx);
    expect(out).toEqual({ total: 5 });
    const conversas = soConversas(calls);
    expect(conversas).toHaveLength(1);
    expect(conversas[0]?.eqs).toMatchObject({ organization_id: ORG, status: "pending" });
  });

  it("contato pessoal fica de fora, como na listagem", async () => {
    const { ctx, calls } = makeCtx({ all: 3 }, { pessoais: [PESSOAL] });
    await crmCountConversations.handler({}, ctx);
    for (const c of soConversas(calls)) {
      expect(c.nots).toContainEqual(["contact_id", "in", `(${PESSOAL})`]);
    }
    const contatos = calls.find((c) => c.table === "contacts");
    expect(contatos?.eqs).toMatchObject({ organization_id: ORG, is_personal: true });
  });

  it("canal desativado fica de fora, e a busca dele é da organização certa", async () => {
    const { ctx, calls } = makeCtx({ all: 3 }, { desativados: [CANAL_OFF] });
    await crmCountConversations.handler({}, ctx);
    for (const c of soConversas(calls)) {
      expect(c.nots).toContainEqual(["channel_session_id", "in", `(${CANAL_OFF})`]);
    }
    const canais = calls.find((c) => c.table === "channel_sessions");
    expect(canais?.eqs.organization_id).toBe(ORG);
  });

  it("em conversa de atendimento conta só o contato do turno", async () => {
    const { ctx, calls } = makeCtx({ all: 1 }, { contatoDoTurno: CONTATO_TURNO });
    await crmCountConversations.handler({}, ctx);
    for (const c of soConversas(calls)) {
      expect(c.eqs.contact_id).toBe(CONTATO_TURNO);
    }
  });

  it("isolamento: nenhuma consulta sai sem organization_id", async () => {
    const { ctx, calls } = makeCtx({ all: 2 }, { pessoais: [PESSOAL], desativados: [CANAL_OFF] });
    await crmCountConversations.handler({}, ctx);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.eqs.organization_id).toBe(ORG);
  });

  it("não expõe conversas, prévias nem dados pessoais", async () => {
    const { ctx } = makeCtx({ all: 5, open: 5 });
    const out = (await crmCountConversations.handler({}, ctx)) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["by_status", "total"]);
    expect(JSON.stringify(out)).not.toMatch(/name|phone|email|preview|uuid|[0-9a-f]{8}-/i);
  });

  it("erro do banco propaga em vez de devolver 0", async () => {
    const { ctx } = makeCtx({}, { error: "boom" });
    await expect(crmCountConversations.handler({}, ctx)).rejects.toThrow("boom");
  });

  it("é só leitura, está exportada no catálogo e no conjunto de ferramentas", () => {
    expect(crmCountConversations.category).toBe("read");
    expect(crmCountConversations.requiresScope).toBe("mcp:read");
    expect(allTools.map((t) => t.name)).toContain("crm_count_conversations");
    expect(TOOL_CATALOG.map((t) => t.name)).toContain("crm_count_conversations");
  });
});
