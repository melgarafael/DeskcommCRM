// @vitest-environment node
/**
 * Recorte SEM banco: montador + policy + SDK/socket MCP reais. Não substitui o
 * caso composto do inbound com PG, nem prova rota HTTP/Auth/UI ou RLS.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";
import { listarFerramentasDoServidor } from "@/lib/mcp/servidor-externo/chamada";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import { ehLeituraRemota } from "@/lib/mcp/servidor-externo/leitura-remota";
import { applyPreviewPolicy, newPreviewResult, scenarioContext, type TurnPreview } from "@/lib/agent-engine/agent/preview";
import type { GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import { abrirMcpDaPrevia } from "../support/mcp-previa-http";

const ORG = "a3564000-0000-4000-8000-000000000001";
const CONTATO = "a3564000-0000-4000-8000-000000000002";
const NOME = "consulta_sintetica";
const abertos: Awaited<ReturnType<typeof abrirMcpDaPrevia>>[] = [];
afterEach(async () => {
  const resultados = await Promise.allSettled(abertos.splice(0).map((s) => s.fechar()));
  for (const r of resultados) if (r.status === "rejected") throw r.reason;
});
async function fornecedor(nome = NOME, hint: { leitura?: boolean } = { leitura: true }) {
  const s = await abrirMcpDaPrevia([{ name: nome, leitura: hint.leitura }]); abertos.push(s); return s;
}
function gate(): GateContext {
  return { now: new Date("2026-09-07T15:00:00Z"), body: "", optedOut: false,
    provider: DEFAULT_CHANNEL_PROVIDER, messagingWindow: { lastInboundAt: new Date("2026-09-07T14:00:00Z") },
    pacing: { knobs: PACING_DEFAULTS, state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] }, promise: { table: null },
    semanticPromise: null, disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null, casesEnabled: false, hasOpenCase: false, openedCaseThisTurn: false };
}
async function montar(s: Awaited<ReturnType<typeof fornecedor>>, opts: {
  leitura?: boolean; contato?: string; identidade?: string; nome?: string; scopes?: string[];
} = {}) {
  const supabase = {} as McpContext["supabase"];
  const auth = { organizationId: ORG, role: "ai_operator", actor: { type: "ai_agent", id: CONTATO, role: "ai_operator" },
    apiTokenId: CONTATO, scopes: opts.scopes ?? ["mcp:read", "mcp:write"] } as McpAuthResult;
  const ctx = { organizationId: ORG, role: auth.role, actor: auth.actor, apiTokenId: CONTATO,
    requestId: CONTATO, supabase } as McpContext;
  const ferramentas = await listarFerramentasDoServidor(s, { fetch: s.fetch });
  return pickToolsFromMcp({ supabase, ctx, auth,
    toolIds: [toolIdRemoto(opts.nome ?? NOME, opts.leitura === false ? "escrita" : "leitura")],
    handoffToolEnabled: false, handoffSignal: { triggered: false },
    ...(opts.contato ? { contatoDoTurno: opts.contato } : {}),
    servidorMcpExterno: { servidor: s, ferramentas, fetch: s.fetch,
      ...(opts.identidade ? { contato: opts.identidade, cabecalhos: { "X-Deskcomm-Contato-Id": opts.identidade } } : {}) },
  });
}
function previa(kind: TurnPreview["kind"]): TurnPreview {
  return { kind, organizationId: ORG, runId: CONTATO, agent: {}, context: scenarioContext([]),
    contactId: kind === "assisted" ? CONTATO : null, channelId: null, result: newPreviewResult() } as TurnPreview;
}
async function executar(tools: ReturnType<typeof applyPreviewPolicy>, nome = NOME) {
  return tools[nome]!.execute!({ consulta: "controle sintético" }, { toolCallId: "controle", messages: [], context: undefined });
}

describe("prévia MCP — montador/policy/transporte (sem inbound/PG)", () => {
  it.each(["sandbox", "assisted"] as const)("%s conserva objeto marcado e executa o SDK no socket", async (kind) => {
    const s = await fornecedor();
    const tools = await montar(s, kind === "assisted" ? { contato: CONTATO, identidade: CONTATO } : {});
    expect(ehLeituraRemota(tools[NOME])).toBe(true);
    const p = previa(kind), permitidas = applyPreviewPolicy(tools, p, gate(), () => []);
    expect(permitidas[NOME]).toBe(tools[NOME]);
    expect(await executar(permitidas)).toEqual({ texto: "O catálogo sintético está disponível." });
    const calls = s.chamadas.filter((c) => c.metodo === "tools/call");
    expect(calls).toHaveLength(1);
    expect(s.chamadas.every((c) => c.autenticada)).toBe(true);
    expect(calls[0]?.contato).toBe(kind === "assisted" ? CONTATO : undefined);
    expect(p.result.impediments).toEqual([]);
  });
  it.each([{ hint: undefined, admin: true }, { hint: false, admin: true }, { hint: true, admin: false }])(
    "hint=$hint/admin=$admin não executa escrita ou leitura sem as duas metades", async ({ hint, admin }) => {
      const s = await fornecedor(NOME, { leitura: hint }), tools = await montar(s, { leitura: admin });
      const p = previa("sandbox");
      await executar(applyPreviewPolicy(tools, p, gate(), () => []));
      expect(ehLeituraRemota(tools[NOME])).toBe(false);
      expect(p.result.impediments).toContainEqual({ code: "unknown_preview_tool", message: NOME });
      expect(s.chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
    },
  );
  it("spread antes da policy não herda a marca por nome", async () => {
    const s = await fornecedor(), tools = await montar(s), copia = { ...tools[NOME]! }, p = previa("sandbox");
    expect(ehLeituraRemota(copia)).toBe(false);
    await executar(applyPreviewPolicy({ [NOME]: copia }, p, gate(), () => []));
    expect(p.result.impediments).toContainEqual({ code: "unknown_preview_tool", message: NOME });
    expect(s.chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
  });
  it("catálogo compilado vence nome remoto colidente", async () => {
    const s = await fornecedor("crm_search_products"), tools = await montar(s, { nome: "crm_search_products" });
    expect(tools.crm_search_products).toBeUndefined();
    expect(s.chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
  });
  it("leitura identificada de outro contato não monta no atendimento", async () => {
    const s = await fornecedor(), tools = await montar(s, { contato: CONTATO, identidade: ORG });
    expect(tools[NOME]).toBeUndefined();
    expect(s.chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
  });
  it("marca não substitui a autorização de escopo do wrapper", async () => {
    const s = await fornecedor(), tools = await montar(s, { scopes: [] }), p = previa("sandbox");
    expect(await executar(applyPreviewPolicy(tools, p, gate(), () => []))).toHaveProperty("error");
    expect(s.chamadas.filter((c) => c.metodo === "tools/call")).toEqual([]);
  });
  it("guard default continua recusando loopback antes de chegar ao socket", async () => {
    const s = await fornecedor();
    await expect(listarFerramentasDoServidor(s)).rejects.toThrow();
    expect(s.chamadas).toEqual([]);
  });
});
