/**
 * #4317 — as consultas dos servidores MCP DO PRÓPRIO agente (migration 9095)
 * na prévia (Testar e rascunho do modo assistido).
 *
 * O caminho medido é o de produção: `pickToolsFromMcp` monta a ferramenta
 * passando por `definirFerramentasDoServidorDoAgente` (onde as duas metades da
 * classificação são decididas) e `applyPreviewPolicy` decide se ela roda.
 * Sem a marca no OBJETO, a política recusa com `unknown_preview_tool` — a falha
 * fechado é o comportamento correto; o conserto é marcar, nunca afrouxar.
 *
 * A marca é do objeto: `tool_ids` dizendo "leitura" não basta, e uma cópia
 * (`{ ...ferramenta }`) não tem autoridade nenhuma.
 */
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { applyPreviewPolicy, newPreviewResult, scenarioContext, type TurnPreview } from "@/lib/agent-engine/agent/preview";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import type { GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { pickToolsFromMcp, type RuntimeHandoffSignal } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import type { ServidorDoAgenteNoTurno } from "@/lib/mcp/servidor-externo/do-agente/carregar";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const SERVIDOR_ID = "5e5e5e5e-0000-4000-8000-000000000748";

/**
 * O que o servidor anuncia. `somenteLeitura` é o que `listarFerramentasDoServidor`
 * captura de `annotations.readOnlyHint === true` — a fixture usa o mesmo campo
 * que a carga real entrega, não a anotação crua.
 */
const FERRAMENTAS: FerramentaRemota[] = [
  // Leitura declarada pelo servidor E marcada pelo admin: roda na prévia.
  { name: "consultar_pedido", description: "Consulta um pedido", somenteLeitura: true },
  // Sem `readOnlyHint`: o admin pode marcar "leitura", mas a definição sai
  // `write` (as duas metades são necessárias).
  { name: "consultar_saldo", description: "Consulta o saldo (não declarado leitura)" },
  // `readOnlyHint: false` explícito: também é escrita para a classificação.
  { name: "alterar_pedido", description: "Altera um pedido" },
];

const TOOL_IDS = [
  toolIdRemoto("consultar_pedido", "leitura", SERVIDOR_ID),
  toolIdRemoto("consultar_saldo", "leitura", SERVIDOR_ID),
  toolIdRemoto("alterar_pedido", "leitura", SERVIDOR_ID),
];

const fetchDaPrevia = vi.fn(async () => {
  throw new Error("a prévia não deveria falar com o servidor neste teste");
}) as unknown as FetchLike & ReturnType<typeof vi.fn>;

function servidorDoAgente(): ServidorDoAgenteNoTurno {
  return {
    estado: "pronto",
    servidor: {
      id: SERVIDOR_ID,
      organizationId: ORG,
      agentId: "a9e1c111-0000-4000-8000-000000000001",
      nome: "ERP do agente",
      slug: "erp",
      endpoint: "https://erp.example.com/mcp",
      modo: "chave_estatica",
      chaveLast4: "1234",
      oauthClientId: null,
      temClientSecret: false,
      oauth: null,
      escoposPedidos: [],
      escritaDelegada: false,
      retencaoHoras: 24,
      ativo: true,
    },
    ferramentas: FERRAMENTAS,
    chamavel: { endpoint: "https://erp.example.com/mcp", chave: "chave-de-teste" },
    fetch: fetchDaPrevia,
  };
}

const auth: McpAuthResult = {
  organizationId: ORG,
  role: "ai_operator",
  actor: {
    type: "ai_agent",
    id: "a9e1c111-0000-4000-8000-000000000001",
    agent_id: "a9e1c111-0000-4000-8000-000000000001",
    role: "ai_operator",
    api_token_id: "token-de-teste",
  },
  apiTokenId: "token-de-teste",
  scopes: ["mcp:read", "mcp:write", "actor:ai_agent"],
};

/** A ponte como o turno do engine a chama (`buildMcpTurnTools` → esta função). */
function montarNaPonte() {
  const supabase = {} as SupabaseClient;
  const handoffSignal: RuntimeHandoffSignal = { triggered: false };
  const ctx = {
    organizationId: ORG,
    role: auth.role,
    actor: auth.actor,
    apiTokenId: auth.apiTokenId,
    requestId: "run-4317",
    supabase,
  } as unknown as McpContext;
  return pickToolsFromMcp({
    supabase,
    ctx,
    auth,
    toolIds: TOOL_IDS,
    handoffToolEnabled: false,
    handoffSignal,
    servidoresDoAgente: [servidorDoAgente()],
  });
}

const preview = (): TurnPreview =>
  ({
    kind: "sandbox",
    organizationId: ORG,
    runId: "preview-4317",
    // Testar roda sem contato; é o caso em que a lista de leituras do catálogo
    // não salva nada e a marca é a única porta.
    contactId: null,
    channelId: null,
    agent: {},
    context: scenarioContext([]),
    result: newPreviewResult(),
  }) as TurnPreview;

const gate = (): GateContext =>
  ({
    now: new Date("2026-11-10T15:00:00Z"),
    body: "",
    optedOut: false,
    provider: DEFAULT_CHANNEL_PROVIDER,
    messagingWindow: { lastInboundAt: new Date("2026-11-10T14:00:00Z") },
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
  }) as GateContext;

async function executar(
  tools: ReturnType<typeof applyPreviewPolicy>,
  nome: string,
): Promise<unknown> {
  return tools[nome]!.execute!({}, { toolCallId: "t", messages: [], context: undefined });
}

describe("#4317 — consultas dos servidores MCP do agente na prévia", () => {
  it("aceita a Leitura com readOnlyHint: true do servidor do agente", () => {
    const p = preview();
    const ponte = montarNaPonte();
    // A ponte montou a remota namespaced e a classificou como leitura.
    expect(Object.keys(ponte)).toContain("erp__consultar_pedido");
    const politica = applyPreviewPolicy(ponte, p, gate(), () => []);
    // Aceita = a política devolve o MESMO objeto da ponte (o da marca). Não se
    // chama o `execute` aqui: ele abriria um socket HTTP de verdade, e o que
    // este teste mede é a decisão da política.
    expect(politica["erp__consultar_pedido"]).toBe(ponte["erp__consultar_pedido"]);
    expect(p.result.impediments).toEqual([]);
    expect(fetchDaPrevia).not.toHaveBeenCalled();
  });

  it("recusa quando o readOnlyHint está ausente ou é false, mesmo marcada Leitura pelo admin", async () => {
    const p = preview();
    const politica = applyPreviewPolicy(montarNaPonte(), p, gate(), () => []);

    const semHint = await executar(politica, "erp__consultar_saldo");
    expect(semHint).toMatchObject({ ok: false, error: { code: "unknown_preview_tool" } });

    const hintFalso = await executar(politica, "erp__alterar_pedido");
    expect(hintFalso).toMatchObject({ ok: false, error: { code: "unknown_preview_tool" } });

    expect(p.result.impediments.map((i) => i.message)).toEqual([
      "erp__consultar_saldo",
      "erp__alterar_pedido",
    ]);
    expect(fetchDaPrevia).not.toHaveBeenCalled();
  });

  it("recusa a Escrita marcada como Leitura pelo admin (o servidor não a declarou leitura)", async () => {
    const p = preview();
    // Mesma bridge, mas a escolha do admin vira `escrita`: a definição já não
    // sai `read` e o objeto não recebe a marca.
    const supabase = {} as SupabaseClient;
    const ponte = pickToolsFromMcp({
      supabase,
      ctx: {
        organizationId: ORG,
        role: auth.role,
        actor: auth.actor,
        apiTokenId: auth.apiTokenId,
        requestId: "run-4317",
        supabase,
      } as unknown as McpContext,
      auth,
      toolIds: [toolIdRemoto("consultar_pedido", "escrita", SERVIDOR_ID)],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      servidoresDoAgente: [servidorDoAgente()],
    });
    const politica = applyPreviewPolicy(ponte, p, gate(), () => []);

    const recusa = await executar(politica, "erp__consultar_pedido");
    expect(recusa).toMatchObject({ ok: false, error: { code: "unknown_preview_tool" } });
    expect(fetchDaPrevia).not.toHaveBeenCalled();
  });

  it("não regride o caso do #3575: cópia do objeto marcado não tem autoridade", async () => {
    const p = preview();
    const ponte = montarNaPonte();
    const marcada = ponte["erp__consultar_pedido"]!;
    const politica = applyPreviewPolicy(
      // Cópia: a marca é por identidade, e o nome não está no catálogo nativo.
      { erp__consultar_pedido: { ...marcada } },
      p,
      gate(),
      () => [],
    );
    const recusa = await executar(politica, "erp__consultar_pedido");
    expect(recusa).toMatchObject({ ok: false, error: { code: "unknown_preview_tool" } });
    expect(p.result.impediments[0]?.code).toBe("unknown_preview_tool");
    expect(fetchDaPrevia).not.toHaveBeenCalled();
  });
});
